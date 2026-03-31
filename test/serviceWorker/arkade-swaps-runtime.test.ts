import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ServiceWorkerArkadeSwaps } from "../../src/serviceWorker/arkade-swaps-runtime";
import {
    DEFAULT_MESSAGE_TAG,
    type RequestInitArkSwaps,
} from "../../src/serviceWorker/arkade-swaps-message-handler";
import type { BoltzReverseSwap, BoltzSubmarineSwap } from "../../src/types";
import { BoltzSwapStatus } from "../../src/boltz-swap-provider";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { decodeInvoice } from "../../src/utils/decoding";
import {
    MESSAGE_BUS_NOT_INITIALIZED,
    ServiceWorkerTimeoutError,
} from "@arkade-os/sdk";

class FakeServiceWorker {
    listeners: ((e: MessageEvent) => void)[] = [];
    postMessage = vi.fn();
    addEventListener = (type: string, cb: (e: MessageEvent) => void) => {
        if (type === "message") this.listeners.push(cb);
    };
    removeEventListener = (type: string, cb: (e: MessageEvent) => void) => {
        if (type === "message") {
            this.listeners = this.listeners.filter((l) => l !== cb);
        }
    };
    emit(data: any) {
        const evt = { data } as MessageEvent;
        this.listeners.forEach((cb) => cb(evt));
    }
}

const TAG = DEFAULT_MESSAGE_TAG;

function createRuntime(fakeSw: FakeServiceWorker) {
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            serviceWorker: fakeSw,
        },
    });

    return ServiceWorkerArkadeSwaps.create({
        serviceWorker: fakeSw as any,
        swapProvider: {
            getApiUrl: () => "http://example.com",
        } as any,
        swapManager: true,
        network: "regtest",
        arkServerUrl: "http://ark.example.com",
    });
}

describe("SwArkadeSwapsRuntime events", () => {
    let fakeSw: FakeServiceWorker;
    let sendMessageSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        fakeSw = new FakeServiceWorker();
        sendMessageSpy = vi.spyOn(
            ServiceWorkerArkadeSwaps.prototype as any,
            "sendMessage"
        );
        sendMessageSpy.mockResolvedValue({
            id: "init",
            tag: TAG,
            type: "ARKADE_SWAPS_INITIALIZED",
        } as any);
    });

    afterEach(() => {
        // cleanup navigator stub
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any).navigator;
        sendMessageSpy.mockRestore();
    });

    it("forwards swap update events to listeners", async () => {
        const runtime = await createRuntime(fakeSw);
        const mgr = runtime.getSwapManager()!;

        const spy = vi.fn();
        await mgr.onSwapUpdate(spy);

        const swap = {
            id: "1",
            type: "reverse",
            status: "swap.created",
        } as BoltzReverseSwap;
        fakeSw.emit({
            tag: TAG,
            type: "SM-EVENT-SWAP_UPDATE",
            payload: { swap, oldStatus: "swap.created" as BoltzSwapStatus },
        });

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(swap, "swap.created");
    });

    it("unsubscribe stops receiving events", async () => {
        const runtime = await createRuntime(fakeSw);
        const mgr = runtime.getSwapManager()!;

        const spy = vi.fn();
        const unsub = await mgr.onSwapCompleted(spy);

        const swap = {
            id: "2",
            type: "submarine",
            status: "transaction.claimed",
        } as BoltzSubmarineSwap;
        fakeSw.emit({
            tag: TAG,
            type: "SM-EVENT-SWAP_COMPLETED",
            payload: { swap },
        });
        expect(spy).toHaveBeenCalledTimes(1);

        unsub();
        fakeSw.emit({
            tag: TAG,
            type: "SM-EVENT-SWAP_COMPLETED",
            payload: { swap },
        });
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("ignores events for other tags", async () => {
        const runtime = await createRuntime(fakeSw);
        const mgr = runtime.getSwapManager()!;
        const spy = vi.fn();
        await mgr.onSwapFailed(spy);

        fakeSw.emit({
            tag: "OTHER",
            type: "SM-EVENT-SWAP_FAILED",
            payload: { swap: { id: "x" } as any, error: { message: "err" } },
        });

        expect(spy).not.toHaveBeenCalled();
    });

    it("subscribeToSwapUpdates filters by swapId and unsubscribes", async () => {
        const runtime = await createRuntime(fakeSw);
        const mgr = runtime.getSwapManager()!;

        const spy = vi.fn();
        const unsubscribe = await mgr.subscribeToSwapUpdates(
            "target-swap",
            spy
        );

        const matchingSwap = {
            id: "target-swap",
            type: "reverse",
            status: "swap.created",
        } as BoltzReverseSwap;
        const otherSwap = {
            id: "other-swap",
            type: "reverse",
            status: "swap.created",
        } as BoltzReverseSwap;

        // Matching id should invoke callback
        fakeSw.emit({
            tag: TAG,
            type: "SM-EVENT-SWAP_UPDATE",
            payload: {
                swap: matchingSwap,
                oldStatus: "swap.created" as BoltzSwapStatus,
            },
        });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(matchingSwap, "swap.created");

        // Different id should be ignored
        fakeSw.emit({
            tag: TAG,
            type: "SM-EVENT-SWAP_UPDATE",
            payload: {
                swap: otherSwap,
                oldStatus: "swap.created" as BoltzSwapStatus,
            },
        });
        expect(spy).toHaveBeenCalledTimes(1);

        // Unsubscribe stops further callbacks
        unsubscribe();
        fakeSw.emit({
            tag: TAG,
            type: "SM-EVENT-SWAP_UPDATE",
            payload: {
                swap: matchingSwap,
                oldStatus: "swap.created" as BoltzSwapStatus,
            },
        });
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

describe("SwArkadeSwapsRuntime enrich methods", () => {
    let fakeSw: FakeServiceWorker;
    let sendMessageSpy: ReturnType<typeof vi.spyOn>;

    const invoice =
        "lntb30m1pw2f2yspp5s59w4a0kjecw3zyexm7zur8l8n4scw674w" +
        "8sftjhwec33km882gsdpa2pshjmt9de6zqun9w96k2um5ypmkjar" +
        "gypkh2mr5d9cxzun5ypeh2ursdae8gxqruyqvzddp68gup69uhnz" +
        "wfj9cejuvf3xshrwde68qcrswf0d46kcarfwpshyaplw3skw0tdw" +
        "4k8g6tsv9e8glzddp68gup69uhnzwfj9cejuvf3xshrwde68qcrs" +
        "wf0d46kcarfwpshyaplw3skw0tdw4k8g6tsv9e8gcqpfmy8keu46" +
        "zsrgtz8sxdym7yedew6v2jyfswg9zeqetpj2yw3f52ny77c5xsrg" +
        "53q9273vvmwhc6p0gucz2av5gtk3esevk0cfhyvzgxgpgyyavt";

    beforeEach(() => {
        fakeSw = new FakeServiceWorker();
        sendMessageSpy = vi.spyOn(
            ServiceWorkerArkadeSwaps.prototype as any,
            "sendMessage"
        );
        sendMessageSpy.mockResolvedValue({
            id: "init",
            tag: TAG,
            type: "ARKADE_SWAPS_INITIALIZED",
        } as any);
    });

    afterEach(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any).navigator;
        sendMessageSpy.mockRestore();
    });

    it("enrichReverseSwapPreimage sets preimage when hash matches", async () => {
        const runtime = await createRuntime(fakeSw);
        const preimage = "11".repeat(32);
        const preimageHash = hex.encode(sha256(hex.decode(preimage)));
        const swap = {
            request: { preimageHash },
            preimage: "",
        } as BoltzReverseSwap;

        const enriched = runtime.enrichReverseSwapPreimage(swap, preimage);

        expect(enriched.preimage).toBe(preimage);
    });

    it("enrichReverseSwapPreimage throws on hash mismatch", async () => {
        const runtime = await createRuntime(fakeSw);
        const swap = {
            request: { preimageHash: "00".repeat(32) },
            preimage: "",
        } as BoltzReverseSwap;

        expect(() =>
            runtime.enrichReverseSwapPreimage(swap, "11".repeat(32))
        ).toThrow(/Preimage does not match swap/);
    });

    it("enrichSubmarineSwapInvoice sets invoice when payment hash matches", async () => {
        const runtime = await createRuntime(fakeSw);
        const paymentHash = decodeInvoice(invoice).paymentHash;
        const swap = {
            preimageHash: paymentHash,
            request: { invoice: "" },
        } as BoltzSubmarineSwap;

        const enriched = runtime.enrichSubmarineSwapInvoice(swap, invoice);

        expect(enriched.request.invoice).toBe(invoice);
    });

    it("enrichSubmarineSwapInvoice throws for invalid invoice", async () => {
        const runtime = await createRuntime(fakeSw);
        const swap = {
            request: { invoice: "" },
        } as BoltzSubmarineSwap;

        expect(() =>
            runtime.enrichSubmarineSwapInvoice(swap, "not-a-lightning-invoice")
        ).toThrow(/Invalid Lightning invoice/);
    });
});

// ---------------------------------------------------------------------------
// Harness helpers for reinitialize / dedup / ping tests
// ---------------------------------------------------------------------------

type MessageHandler = (event: { data: any }) => void;

function structuredCloneError(error: Error): Error {
    const cloned = new Error(error.message);
    cloned.name = error.name;
    return cloned;
}

function structuredCloneResponse(response: any): any {
    if (!response || !response.error) return response;
    return { ...response, error: structuredCloneError(response.error) };
}

const createServiceWorkerHarness = (
    responder?: (message: any) => any,
    options?: { handlePing?: boolean }
) => {
    const handlePing = options?.handlePing ?? true;
    const listeners = new Set<MessageHandler>();

    const navigatorServiceWorker = {
        addEventListener: vi.fn((type: string, handler: MessageHandler) => {
            if (type === "message") listeners.add(handler);
        }),
        removeEventListener: vi.fn((type: string, handler: MessageHandler) => {
            if (type === "message") listeners.delete(handler);
        }),
    };

    const serviceWorker = {
        postMessage: vi.fn((message: any) => {
            if (handlePing && message.tag === "PING") {
                listeners.forEach((handler) =>
                    handler({
                        data: { id: message.id, tag: "PONG" },
                    })
                );
                return;
            }
            if (!responder) return;
            const response = responder(message);
            if (!response) return;
            const cloned = structuredCloneResponse(response);
            listeners.forEach((handler) => handler({ data: cloned }));
        }),
    };

    const emit = (data: any) => {
        const cloned = structuredCloneResponse(data);
        listeners.forEach((handler) => handler({ data: cloned }));
    };

    return { navigatorServiceWorker, serviceWorker, emit, listeners };
};

const stubInitPayload: RequestInitArkSwaps["payload"] = {
    network: "regtest",
    arkServerUrl: "https://ark.test",
    swapProvider: { baseUrl: "https://boltz.test" },
};

const createRuntimeWithConfig = (
    serviceWorker: ServiceWorker,
    tag = TAG
): ServiceWorkerArkadeSwaps => {
    const runtime = new (ServiceWorkerArkadeSwaps as any)(
        tag,
        serviceWorker,
        {} as any, // swapRepository — not needed for messaging tests
        false // withSwapManager
    ) as ServiceWorkerArkadeSwaps;
    (runtime as any).initPayload = stubInitPayload;
    return runtime;
};

// ---------------------------------------------------------------------------
// sendMessage reinitialize on SW restart
// ---------------------------------------------------------------------------

describe("sendMessage reinitialize on SW restart", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("retries after re-initializing when SW returns 'MessageBus not initialized'", async () => {
        let handlerInitialized = false;
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
                if (message.type === "INIT_ARKADE_SWAPS") {
                    handlerInitialized = true;
                    return {
                        id: message.id,
                        tag: TAG,
                        type: "ARKADE_SWAPS_INITIALIZED",
                    };
                }
                if (!handlerInitialized) {
                    return {
                        id: message.id,
                        tag: TAG,
                        error: new Error(MESSAGE_BUS_NOT_INITIALIZED),
                    };
                }
                if (message.type === "GET_FEES") {
                    return {
                        id: message.id,
                        tag: TAG,
                        type: "FEES",
                        payload: { minerFees: 100 },
                    };
                }
                return null;
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);
        const fees = await runtime.getFees();

        expect(fees).toEqual({ minerFees: 100 });
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "INIT_ARKADE_SWAPS" })
        );
    });

    it("throws after exhausting retries", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
                if (message.type === "INIT_ARKADE_SWAPS") {
                    return {
                        id: message.id,
                        tag: TAG,
                        type: "ARKADE_SWAPS_INITIALIZED",
                    };
                }
                // Always return not-initialized (simulates persistent failure)
                return {
                    id: message.id,
                    tag: TAG,
                    error: new Error(MESSAGE_BUS_NOT_INITIALIZED),
                };
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);
        // refreshSwapsStatus doesn't wrap errors, so we see the raw message
        await expect(runtime.refreshSwapsStatus()).rejects.toThrow(
            MESSAGE_BUS_NOT_INITIALIZED
        );

        // Should have tried 3 times (1 initial + 2 retries)
        const refreshCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "REFRESH_SWAPS_STATUS"
        );
        expect(refreshCalls).toHaveLength(3);
    });

    it("deduplicates concurrent reinitializations", async () => {
        let handlerInitialized = false;
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
                if (message.type === "INIT_ARKADE_SWAPS") {
                    handlerInitialized = true;
                    return {
                        id: message.id,
                        tag: TAG,
                        type: "ARKADE_SWAPS_INITIALIZED",
                    };
                }
                if (!handlerInitialized) {
                    return {
                        id: message.id,
                        tag: TAG,
                        error: new Error(MESSAGE_BUS_NOT_INITIALIZED),
                    };
                }
                switch (message.type) {
                    case "GET_FEES":
                        return {
                            id: message.id,
                            tag: TAG,
                            type: "FEES",
                            payload: { minerFees: 50 },
                        };
                    case "GET_LIMITS":
                        return {
                            id: message.id,
                            tag: TAG,
                            type: "LIMITS",
                            payload: { min: 100 },
                        };
                    default:
                        return null;
                }
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);

        // Both fail simultaneously, triggering concurrent reinit
        const [fees, limits] = await Promise.all([
            runtime.getFees(),
            runtime.getLimits(),
        ]);

        expect(fees).toEqual({ minerFees: 50 });
        expect(limits).toEqual({ min: 100 });

        // INIT_ARKADE_SWAPS should have been sent only once
        const initCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "INIT_ARKADE_SWAPS"
        );
        expect(initCalls).toHaveLength(1);
    });

    it("does not retry for errors other than 'not initialized'", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => ({
                id: message.id,
                tag: TAG,
                error: new Error("something else went wrong"),
            }));

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);
        // refreshSwapsStatus doesn't wrap errors, so we see the raw message
        await expect(runtime.refreshSwapsStatus()).rejects.toThrow(
            "something else went wrong"
        );

        // Should have tried only once (no retry for unrelated errors)
        const refreshCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "REFRESH_SWAPS_STATUS"
        );
        expect(refreshCalls).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// In-flight request deduplication
// ---------------------------------------------------------------------------

describe("in-flight request deduplication", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("deduplicates concurrent identical reads", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
                if (message.type === "GET_FEES") {
                    return {
                        id: message.id,
                        tag: TAG,
                        type: "FEES",
                        payload: { minerFees: 200 },
                    };
                }
                return null;
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);
        const [f1, f2] = await Promise.all([
            runtime.getFees(),
            runtime.getFees(),
        ]);

        expect(f1).toEqual({ minerFees: 200 });
        expect(f2).toEqual({ minerFees: 200 });

        const feesCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_FEES"
        );
        expect(feesCalls).toHaveLength(1);
    });

    it("does not dedup state-mutating requests", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
                if (message.type === "CREATE_REVERSE_SWAP") {
                    return {
                        id: message.id,
                        tag: TAG,
                        type: "REVERSE_SWAP_CREATED",
                        payload: { id: "swap-" + message.id },
                    };
                }
                return null;
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);
        const args = { amountSats: 10_000 } as any;
        await Promise.all([
            runtime.createReverseSwap(args),
            runtime.createReverseSwap(args),
        ]);

        const createCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "CREATE_REVERSE_SWAP"
        );
        expect(createCalls).toHaveLength(2);
    });

    it("deduplicates requests with identical payloads", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
                if (message.type === "GET_SWAP_STATUS") {
                    return {
                        id: message.id,
                        tag: TAG,
                        type: "SWAP_STATUS",
                        payload: { status: "swap.created" },
                    };
                }
                return null;
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);
        await Promise.all([
            runtime.getSwapStatus("swap-123"),
            runtime.getSwapStatus("swap-123"),
        ]);

        const statusCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_SWAP_STATUS"
        );
        expect(statusCalls).toHaveLength(1);
    });

    it("does NOT dedup different payloads", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
                if (message.type === "GET_SWAP_STATUS") {
                    return {
                        id: message.id,
                        tag: TAG,
                        type: "SWAP_STATUS",
                        payload: { status: "swap.created" },
                    };
                }
                return null;
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);
        await Promise.all([
            runtime.getSwapStatus("swap-aaa"),
            runtime.getSwapStatus("swap-bbb"),
        ]);

        const statusCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_SWAP_STATUS"
        );
        expect(statusCalls).toHaveLength(2);
    });

    it("cache clears after settlement so sequential calls hit SW", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
                if (message.type === "GET_FEES") {
                    return {
                        id: message.id,
                        tag: TAG,
                        type: "FEES",
                        payload: { minerFees: 0 },
                    };
                }
                return null;
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);

        await runtime.getFees();
        await runtime.getFees();

        const feesCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_FEES"
        );
        expect(feesCalls).toHaveLength(2);
    });

    it("shares error across deduped callers", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
                if (message.type === "GET_FEES") {
                    return {
                        id: message.id,
                        tag: TAG,
                        error: new Error("server exploded"),
                    };
                }
                return null;
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);
        const results = await Promise.allSettled([
            runtime.getFees(),
            runtime.getFees(),
        ]);

        expect(results[0].status).toBe("rejected");
        expect(results[1].status).toBe("rejected");
        // getFees wraps errors — the original is in cause
        const cause0 = (results[0] as PromiseRejectedResult).reason.cause;
        const cause1 = (results[1] as PromiseRejectedResult).reason.cause;
        expect(cause0.message).toContain("server exploded");
        expect(cause1.message).toContain("server exploded");

        const feesCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.type === "GET_FEES"
        );
        expect(feesCalls).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Preflight ping
// ---------------------------------------------------------------------------

describe("preflight ping", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("ping succeeds → request proceeds normally", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
                if (message.type === "GET_FEES") {
                    return {
                        id: message.id,
                        tag: TAG,
                        type: "FEES",
                        payload: { minerFees: 42 },
                    };
                }
                return null;
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);
        const fees = await runtime.getFees();

        expect(fees).toEqual({ minerFees: 42 });
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ tag: "PING" })
        );
    });

    it("reinitializes when ping fails (dead SW)", async () => {
        vi.useFakeTimers();

        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness(
                (message) => {
                    if (message.type === "INIT_ARKADE_SWAPS") {
                        return {
                            id: message.id,
                            tag: TAG,
                            type: "ARKADE_SWAPS_INITIALIZED",
                        };
                    }
                    if (message.type === "GET_FEES") {
                        return {
                            id: message.id,
                            tag: TAG,
                            type: "FEES",
                            payload: { minerFees: 99 },
                        };
                    }
                    return null;
                },
                { handlePing: false }
            );

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);
        const feesPromise = runtime.getFees();

        // Advance past the 2s ping timeout
        await vi.advanceTimersByTimeAsync(2_000);

        const fees = await feesPromise;
        expect(fees).toEqual({ minerFees: 99 });
        expect(serviceWorker.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "INIT_ARKADE_SWAPS" })
        );
    });

    it("deduplicates concurrent pings", async () => {
        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness((message) => {
                switch (message.type) {
                    case "GET_FEES":
                        return {
                            id: message.id,
                            tag: TAG,
                            type: "FEES",
                            payload: { minerFees: 0 },
                        };
                    case "GET_LIMITS":
                        return {
                            id: message.id,
                            tag: TAG,
                            type: "LIMITS",
                            payload: { min: 0 },
                        };
                    default:
                        return null;
                }
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);
        await Promise.all([runtime.getFees(), runtime.getLimits()]);

        const pingCalls = serviceWorker.postMessage.mock.calls.filter(
            ([msg]: any) => msg.tag === "PING"
        );
        expect(pingCalls).toHaveLength(1);
    });

    it("ping times out after 2s, not 30s", async () => {
        vi.useFakeTimers();

        const { navigatorServiceWorker, serviceWorker } =
            createServiceWorkerHarness(undefined, {
                handlePing: false,
            });

        vi.stubGlobal("navigator", {
            serviceWorker: navigatorServiceWorker,
        } as any);

        const runtime = createRuntimeWithConfig(serviceWorker as any);
        const pingPromise = (runtime as any).pingServiceWorker();

        const assertion = expect(pingPromise).rejects.toBeInstanceOf(
            ServiceWorkerTimeoutError
        );
        await vi.advanceTimersByTimeAsync(2_000);
        await assertion;
    });
});
