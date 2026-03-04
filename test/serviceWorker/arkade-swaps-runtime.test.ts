import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ServiceWorkerArkadeSwaps } from "../../src/serviceWorker/arkade-swaps-runtime";
import { DEFAULT_MESSAGE_TAG } from "../../src/serviceWorker/arkade-swaps-message-handler";
import type { PendingReverseSwap, PendingSubmarineSwap } from "../../src/types";
import { BoltzSwapStatus } from "../../src/boltz-swap-provider";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { decodeInvoice } from "../../src/utils/decoding";

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
        } as PendingReverseSwap;
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
        } as PendingSubmarineSwap;
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
        } as PendingReverseSwap;
        const otherSwap = {
            id: "other-swap",
            type: "reverse",
            status: "swap.created",
        } as PendingReverseSwap;

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
        } as PendingReverseSwap;

        const enriched = runtime.enrichReverseSwapPreimage(swap, preimage);

        expect(enriched.preimage).toBe(preimage);
    });

    it("enrichReverseSwapPreimage throws on hash mismatch", async () => {
        const runtime = await createRuntime(fakeSw);
        const swap = {
            request: { preimageHash: "00".repeat(32) },
            preimage: "",
        } as PendingReverseSwap;

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
        } as PendingSubmarineSwap;

        const enriched = runtime.enrichSubmarineSwapInvoice(swap, invoice);

        expect(enriched.request.invoice).toBe(invoice);
    });

    it("enrichSubmarineSwapInvoice throws for invalid invoice", async () => {
        const runtime = await createRuntime(fakeSw);
        const swap = {
            request: { invoice: "" },
        } as PendingSubmarineSwap;

        expect(() =>
            runtime.enrichSubmarineSwapInvoice(swap, "not-a-lightning-invoice")
        ).toThrow(/Invalid Lightning invoice/);
    });
});
