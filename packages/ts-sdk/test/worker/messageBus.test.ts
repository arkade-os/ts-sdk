import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryWalletRepository, InMemoryContractRepository } from "../../src";
import {
    MessageBus,
    MessageHandler,
    RequestEnvelope,
    ResponseEnvelope,
} from "../../src/worker/messageBus";
import {
    MESSAGE_BUS_INITIALIZING,
    MESSAGE_BUS_NOT_INITIALIZED,
    MessageBusInitializingError,
    MessageBusNotInitializedError,
    ServiceWorkerTimeoutError,
} from "../../src/worker/errors";

type StubbedSelf = {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    skipWaiting: ReturnType<typeof vi.fn>;
    clients: {
        claim: ReturnType<typeof vi.fn>;
        matchAll: ReturnType<typeof vi.fn>;
    };
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
};

let messageHandler: (event: {
    data: RequestEnvelope | { type: string; id?: string; config?: unknown };
    source: { postMessage: (m: unknown) => void } | null;
    waitUntil: (p: Promise<unknown>) => unknown;
}) => Promise<void>;

function installSelfStub(): StubbedSelf {
    const selfMock: StubbedSelf = {
        addEventListener: vi.fn((type: string, handler: Function) => {
            if (type === "message") messageHandler = handler as typeof messageHandler;
        }),
        removeEventListener: vi.fn(),
        skipWaiting: vi.fn(),
        clients: {
            claim: vi.fn(),
            matchAll: vi.fn().mockResolvedValue([]),
        },
        // Use globalThis so these work with vi.useFakeTimers() for timeout tests
        setTimeout: ((fn: () => void, ms: number) =>
            globalThis.setTimeout(fn, ms)) as unknown as typeof setTimeout,
        clearTimeout: ((id: unknown) =>
            globalThis.clearTimeout(
                id as Parameters<typeof globalThis.clearTimeout>[0],
            )) as unknown as typeof clearTimeout,
    };
    vi.stubGlobal("self", selfMock);
    return selfMock;
}

class TestHandler implements MessageHandler {
    readonly messageTag: string;
    handleMessage = vi.fn<(message: RequestEnvelope) => Promise<ResponseEnvelope | null>>();
    tick = vi.fn<(now: number) => Promise<ResponseEnvelope[]>>().mockResolvedValue([]);
    start = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    stop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    constructor(tag = "TEST_HANDLER") {
        this.messageTag = tag;
    }
}

async function createAndInitBus(options: {
    handlers: MessageHandler[];
    messageTimeoutMs?: number;
    messageTimeoutOverrides?: Record<string, number>;
    debug?: boolean;
}) {
    const bus = new MessageBus(new InMemoryWalletRepository(), new InMemoryContractRepository(), {
        messageHandlers: options.handlers,
        messageTimeoutMs: options.messageTimeoutMs ?? 30_000,
        messageTimeoutOverrides: options.messageTimeoutOverrides,
        debug: options.debug ?? false,
        // Bypass the real buildServices — it tries to talk to networks.
        buildServices: async () => ({}) as never,
    });
    await bus.start();
    const initSource = { postMessage: vi.fn() };
    await messageHandler({
        data: {
            type: "INITIALIZE_MESSAGE_BUS",
            id: "init-1",
            tag: "INITIALIZE_MESSAGE_BUS",
            config: {
                wallet: { publicKey: "00".repeat(33) },
                arkServer: { url: "http://localhost" },
            },
        } as never,
        source: initSource as never,
        waitUntil: (p: Promise<unknown>) => p,
    });
    return bus;
}

describe("MessageBus PING/PONG", () => {
    beforeEach(() => {
        installSelfStub();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("responds to PING with PONG", async () => {
        const bus = new MessageBus(
            new InMemoryWalletRepository(),
            new InMemoryContractRepository(),
            { messageHandlers: [] },
        );
        await bus.start();

        const postMessage = vi.fn();
        await messageHandler({
            data: { id: "ping-1", tag: "PING" },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        expect(postMessage).toHaveBeenCalledWith({
            id: "ping-1",
            tag: "PONG",
        });

        await bus.stop();
    });

    it("responds to PING even when bus is not initialized", async () => {
        const bus = new MessageBus(
            new InMemoryWalletRepository(),
            new InMemoryContractRepository(),
            { messageHandlers: [] },
        );
        await bus.start();

        const postMessage = vi.fn();
        await messageHandler({
            data: { id: "ping-2", tag: "PING" },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        expect(postMessage).toHaveBeenCalledWith({
            id: "ping-2",
            tag: "PONG",
        });
        expect(postMessage).toHaveBeenCalledTimes(1);

        await bus.stop();
    });
});

describe("MessageBus delivery guarantees (issue #448)", () => {
    let handler: TestHandler;

    beforeEach(() => {
        installSelfStub();
        handler = new TestHandler();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it("responds with an error when the message tag has no registered handler", async () => {
        const bus = await createAndInitBus({ handlers: [handler] });
        const postMessage = vi.fn();

        await messageHandler({
            data: { id: "m1", tag: "DOES_NOT_EXIST" },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        expect(postMessage).toHaveBeenCalledTimes(1);
        const sent = postMessage.mock.calls[0][0] as ResponseEnvelope;
        expect(sent.id).toBe("m1");
        expect(sent.tag).toBe("DOES_NOT_EXIST");
        expect(sent.error).toBeInstanceOf(Error);
        expect(sent.error?.message).toMatch(/Unknown handler tag/);

        await bus.stop();
    });

    it("delivers an ack envelope when a handler returns null", async () => {
        handler.handleMessage.mockResolvedValueOnce(null);
        const bus = await createAndInitBus({ handlers: [handler] });
        const postMessage = vi.fn();

        await messageHandler({
            data: { id: "m2", tag: handler.messageTag },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith({
            id: "m2",
            tag: handler.messageTag,
        });

        await bus.stop();
    });

    it("delivers an ack envelope when a handler returns undefined", async () => {
        handler.handleMessage.mockResolvedValueOnce(undefined as unknown as ResponseEnvelope);
        const bus = await createAndInitBus({ handlers: [handler] });
        const postMessage = vi.fn();

        await messageHandler({
            data: { id: "m3", tag: handler.messageTag },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        expect(postMessage).toHaveBeenCalledWith({
            id: "m3",
            tag: handler.messageTag,
        });

        await bus.stop();
    });

    it("delivers the handler's response verbatim when it is truthy", async () => {
        handler.handleMessage.mockResolvedValueOnce({
            id: "m4",
            tag: handler.messageTag,
            payload: { ok: true },
        } as ResponseEnvelope);
        const bus = await createAndInitBus({ handlers: [handler] });
        const postMessage = vi.fn();

        await messageHandler({
            data: { id: "m4", tag: handler.messageTag, type: "GET_BALANCE" },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ id: "m4", payload: { ok: true } }),
        );

        await bus.stop();
    });

    it("reports timeout errors with message type and handler tag in the label", async () => {
        vi.useFakeTimers();
        handler.handleMessage.mockReturnValueOnce(new Promise(() => {}));
        const bus = await createAndInitBus({
            handlers: [handler],
            messageTimeoutMs: 100,
        });
        const postMessage = vi.fn();

        const processed = messageHandler({
            data: {
                id: "m5",
                tag: handler.messageTag,
                type: "SETTLE",
            } as RequestEnvelope & { type: string },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        await vi.advanceTimersByTimeAsync(150);
        await processed;

        const sent = postMessage.mock.calls[0][0] as ResponseEnvelope;
        expect(sent.id).toBe("m5");
        expect(sent.tag).toBe(handler.messageTag);
        expect(sent.error).toBeInstanceOf(ServiceWorkerTimeoutError);
        expect(sent.error?.message).toContain("SETTLE via TEST_HANDLER");
        expect(sent.error?.message).toContain("100ms");

        await bus.stop();
    });

    it("falls back to the handler tag in the label when no message type is provided", async () => {
        vi.useFakeTimers();
        handler.handleMessage.mockReturnValueOnce(new Promise(() => {}));
        const bus = await createAndInitBus({
            handlers: [handler],
            messageTimeoutMs: 50,
        });
        const postMessage = vi.fn();

        const processed = messageHandler({
            data: { id: "m6", tag: handler.messageTag },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        await vi.advanceTimersByTimeAsync(100);
        await processed;

        const sent = postMessage.mock.calls[0][0] as ResponseEnvelope;
        expect(sent.error?.message).toContain("(TEST_HANDLER)");
        expect(sent.error?.message).not.toContain(" via ");

        await bus.stop();
    });

    it("honours per-message-type timeout overrides", async () => {
        vi.useFakeTimers();
        handler.handleMessage.mockReturnValueOnce(new Promise(() => {}));
        const bus = await createAndInitBus({
            handlers: [handler],
            messageTimeoutMs: 30_000,
            messageTimeoutOverrides: { SETTLE: 100 },
        });
        const postMessage = vi.fn();

        const processed = messageHandler({
            data: {
                id: "m7",
                tag: handler.messageTag,
                type: "SETTLE",
            } as RequestEnvelope & { type: string },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        // The override (100ms) should fire long before the default (30s).
        await vi.advanceTimersByTimeAsync(150);
        await processed;

        const sent = postMessage.mock.calls[0][0] as ResponseEnvelope;
        expect(sent.error?.message).toContain("100ms");

        await bus.stop();
    });

    it("honours per-handler-tag timeout overrides when no message-type override matches", async () => {
        vi.useFakeTimers();
        handler.handleMessage.mockReturnValueOnce(new Promise(() => {}));
        const bus = await createAndInitBus({
            handlers: [handler],
            messageTimeoutMs: 30_000,
            messageTimeoutOverrides: { TEST_HANDLER: 80 },
        });
        const postMessage = vi.fn();

        const processed = messageHandler({
            data: {
                id: "m8",
                tag: handler.messageTag,
                type: "GET_BALANCE",
            } as RequestEnvelope & { type: string },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        await vi.advanceTimersByTimeAsync(120);
        await processed;

        const sent = postMessage.mock.calls[0][0] as ResponseEnvelope;
        expect(sent.error?.message).toContain("80ms");

        await bus.stop();
    });

    it("prefers INIT-supplied messageTimeouts over constructor overrides", async () => {
        vi.useFakeTimers();
        handler.handleMessage.mockReturnValueOnce(new Promise(() => {}));
        // Constructor sets SETTLE to 5s; INIT will override it to 100ms.
        const bus = new MessageBus(
            new InMemoryWalletRepository(),
            new InMemoryContractRepository(),
            {
                messageHandlers: [handler],
                messageTimeoutMs: 30_000,
                messageTimeoutOverrides: { SETTLE: 5_000 },
                buildServices: async () => ({}) as never,
            },
        );
        await bus.start();
        const initSource = { postMessage: vi.fn() };
        await messageHandler({
            data: {
                type: "INITIALIZE_MESSAGE_BUS",
                id: "init-prec",
                tag: "INITIALIZE_MESSAGE_BUS",
                config: {
                    wallet: { publicKey: "00".repeat(33) },
                    arkServer: { url: "http://localhost" },
                    messageTimeouts: { SETTLE: 100 },
                },
            } as never,
            source: initSource as never,
            waitUntil: (p: Promise<unknown>) => p,
        });
        const postMessage = vi.fn();

        const processed = messageHandler({
            data: {
                id: "prec-1",
                tag: handler.messageTag,
                type: "SETTLE",
            } as RequestEnvelope & { type: string },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        // INIT's 100ms should fire long before the constructor's 5s.
        await vi.advanceTimersByTimeAsync(150);
        await processed;

        const sent = postMessage.mock.calls[0][0] as ResponseEnvelope;
        expect(sent.error?.message).toContain("100ms");

        await bus.stop();
    });

    it("recomputes the active timeout map on every init (no stale keys)", async () => {
        vi.useFakeTimers();
        const bus = new MessageBus(
            new InMemoryWalletRepository(),
            new InMemoryContractRepository(),
            {
                messageHandlers: [handler],
                messageTimeoutMs: 30_000,
                buildServices: async () => ({}) as never,
            },
        );
        await bus.start();

        // First init introduces a SETTLE override.
        const initSource = { postMessage: vi.fn() };
        await messageHandler({
            data: {
                type: "INITIALIZE_MESSAGE_BUS",
                id: "init-a",
                tag: "INITIALIZE_MESSAGE_BUS",
                config: {
                    wallet: { publicKey: "00".repeat(33) },
                    arkServer: { url: "http://localhost" },
                    messageTimeouts: { SETTLE: 100 },
                },
            } as never,
            source: initSource as never,
            waitUntil: (p: Promise<unknown>) => p,
        });

        // Re-init without SETTLE in the new map — the previous override
        // must not persist.
        await messageHandler({
            data: {
                type: "INITIALIZE_MESSAGE_BUS",
                id: "init-b",
                tag: "INITIALIZE_MESSAGE_BUS",
                config: {
                    wallet: { publicKey: "00".repeat(33) },
                    arkServer: { url: "http://localhost" },
                    messageTimeouts: { GET_BALANCE: 200 },
                },
            } as never,
            source: initSource as never,
            waitUntil: (p: Promise<unknown>) => p,
        });

        handler.handleMessage.mockReturnValueOnce(new Promise(() => {}));
        const postMessage = vi.fn();
        const processed = messageHandler({
            data: {
                id: "recompute-1",
                tag: handler.messageTag,
                type: "SETTLE",
            } as RequestEnvelope & { type: string },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        // With SETTLE no longer overridden, the bus default (30s) applies.
        // Advance past the old 100ms override — no response should be posted.
        await vi.advanceTimersByTimeAsync(500);
        expect(postMessage).not.toHaveBeenCalled();

        // Advance past the default 30s and confirm the default fires.
        await vi.advanceTimersByTimeAsync(30_000);
        await processed;
        const sent = postMessage.mock.calls[0][0] as ResponseEnvelope;
        expect(sent.error?.message).toContain("30000ms");

        await bus.stop();
    });

    it("prefers message-type override over handler-tag override when both match", async () => {
        vi.useFakeTimers();
        handler.handleMessage.mockReturnValueOnce(new Promise(() => {}));
        const bus = await createAndInitBus({
            handlers: [handler],
            messageTimeoutMs: 30_000,
            messageTimeoutOverrides: {
                TEST_HANDLER: 30_000,
                SETTLE: 60,
            },
        });
        const postMessage = vi.fn();

        const processed = messageHandler({
            data: {
                id: "m9",
                tag: handler.messageTag,
                type: "SETTLE",
            } as RequestEnvelope & { type: string },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        await vi.advanceTimersByTimeAsync(100);
        await processed;

        const sent = postMessage.mock.calls[0][0] as ResponseEnvelope;
        expect(sent.error?.message).toContain("60ms");

        await bus.stop();
    });

    it("delivers late handler result under the original id after a timeout", async () => {
        vi.useFakeTimers();
        let resolveLate: ((r: ResponseEnvelope) => void) | undefined;
        handler.handleMessage.mockReturnValueOnce(
            new Promise<ResponseEnvelope>((resolve) => {
                resolveLate = resolve;
            }),
        );
        const bus = await createAndInitBus({
            handlers: [handler],
            messageTimeoutMs: 50,
        });
        const postMessage = vi.fn();

        const processed = messageHandler({
            data: {
                id: "m10",
                tag: handler.messageTag,
                type: "SETTLE",
            } as RequestEnvelope & { type: string },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        await vi.advanceTimersByTimeAsync(100);
        await processed;

        // First response: the timeout error
        expect(postMessage).toHaveBeenCalledTimes(1);
        expect((postMessage.mock.calls[0][0] as ResponseEnvelope).error).toBeInstanceOf(
            ServiceWorkerTimeoutError,
        );

        // Handler now completes late
        resolveLate!({
            id: "m10",
            tag: handler.messageTag,
            payload: { settled: true },
        } as ResponseEnvelope);
        // Flush the microtasks that deliver the late response (the handler's
        // .then continuations). Do not use runAllTimersAsync here because
        // the bus's recurring tick timer would never settle.
        await vi.advanceTimersByTimeAsync(0);

        // Second response: the late result with the same id
        expect(postMessage).toHaveBeenCalledTimes(2);
        expect(postMessage.mock.calls[1][0]).toEqual(
            expect.objectContaining({
                id: "m10",
                payload: { settled: true },
            }),
        );

        await bus.stop();
    });

    it("delivers late handler error under the original id after a timeout", async () => {
        vi.useFakeTimers();
        let rejectLate: ((e: Error) => void) | undefined;
        handler.handleMessage.mockReturnValueOnce(
            new Promise<ResponseEnvelope>((_, reject) => {
                rejectLate = reject;
            }),
        );
        const bus = await createAndInitBus({
            handlers: [handler],
            messageTimeoutMs: 50,
        });
        const postMessage = vi.fn();

        const processed = messageHandler({
            data: {
                id: "m11",
                tag: handler.messageTag,
                type: "SETTLE",
            } as RequestEnvelope & { type: string },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        await vi.advanceTimersByTimeAsync(100);
        await processed;

        rejectLate!(new Error("late failure"));
        await vi.advanceTimersByTimeAsync(0);

        expect(postMessage).toHaveBeenCalledTimes(2);
        const lateResponse = postMessage.mock.calls[1][0] as ResponseEnvelope;
        expect(lateResponse.id).toBe("m11");
        expect(lateResponse.tag).toBe(handler.messageTag);
        expect(lateResponse.error?.message).toBe("late failure");

        await bus.stop();
    });

    it("sends an 'Operation abandoned' error if the handler never completes within the grace window", async () => {
        vi.useFakeTimers();
        handler.handleMessage.mockReturnValueOnce(new Promise(() => {}));
        const bus = await createAndInitBus({
            handlers: [handler],
            messageTimeoutMs: 50,
        });
        const postMessage = vi.fn();

        const processed = messageHandler({
            data: {
                id: "m12",
                tag: handler.messageTag,
                type: "SETTLE",
            } as RequestEnvelope & { type: string },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        await vi.advanceTimersByTimeAsync(100);
        await processed;

        // Advance past the 5-minute grace window.
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);

        expect(postMessage).toHaveBeenCalledTimes(2);
        const abandoned = postMessage.mock.calls[1][0] as ResponseEnvelope;
        expect(abandoned.id).toBe("m12");
        expect(abandoned.tag).toBe(handler.messageTag);
        expect(abandoned.error?.message).toMatch(/Operation abandoned/);

        await bus.stop();
    });

    it("does not deliver a third response when the handler resolves after the abandoned deadline", async () => {
        vi.useFakeTimers();
        let resolveLate: ((r: ResponseEnvelope) => void) | undefined;
        handler.handleMessage.mockReturnValueOnce(
            new Promise<ResponseEnvelope>((resolve) => {
                resolveLate = resolve;
            }),
        );
        const bus = await createAndInitBus({
            handlers: [handler],
            messageTimeoutMs: 50,
        });
        const postMessage = vi.fn();

        const processed = messageHandler({
            data: {
                id: "m14",
                tag: handler.messageTag,
                type: "SETTLE",
            } as RequestEnvelope & { type: string },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        await vi.advanceTimersByTimeAsync(100);
        await processed;
        // Advance past the grace window — abandoned error fires.
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
        expect(postMessage).toHaveBeenCalledTimes(2);

        // Handler now completes very late; must NOT produce a third response.
        resolveLate!({
            id: "m14",
            tag: handler.messageTag,
            payload: { settled: true },
        } as ResponseEnvelope);
        await vi.advanceTimersByTimeAsync(0);

        expect(postMessage).toHaveBeenCalledTimes(2);

        await bus.stop();
    });

    it("does not deliver a third response when the handler rejects after the abandoned deadline", async () => {
        vi.useFakeTimers();
        let rejectLate: ((e: Error) => void) | undefined;
        handler.handleMessage.mockReturnValueOnce(
            new Promise<ResponseEnvelope>((_, reject) => {
                rejectLate = reject;
            }),
        );
        const bus = await createAndInitBus({
            handlers: [handler],
            messageTimeoutMs: 50,
        });
        const postMessage = vi.fn();

        const processed = messageHandler({
            data: {
                id: "m15",
                tag: handler.messageTag,
                type: "SETTLE",
            } as RequestEnvelope & { type: string },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        await vi.advanceTimersByTimeAsync(100);
        await processed;
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
        expect(postMessage).toHaveBeenCalledTimes(2);

        rejectLate!(new Error("very late failure"));
        await vi.advanceTimersByTimeAsync(0);

        expect(postMessage).toHaveBeenCalledTimes(2);

        await bus.stop();
    });

    it("does not deliver late responses after bus.stop()", async () => {
        vi.useFakeTimers();
        let resolveLate: ((r: ResponseEnvelope) => void) | undefined;
        handler.handleMessage.mockReturnValueOnce(
            new Promise<ResponseEnvelope>((resolve) => {
                resolveLate = resolve;
            }),
        );
        const bus = await createAndInitBus({
            handlers: [handler],
            messageTimeoutMs: 50,
        });
        const postMessage = vi.fn();

        const processed = messageHandler({
            data: {
                id: "m16",
                tag: handler.messageTag,
                type: "SETTLE",
            } as RequestEnvelope & { type: string },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        await vi.advanceTimersByTimeAsync(100);
        await processed;
        // One response delivered so far: the timeout error.
        expect(postMessage).toHaveBeenCalledTimes(1);

        await bus.stop();
        const countAtStop = postMessage.mock.calls.length;

        // Neither the grace deadline nor a late handler settle should post now.
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
        resolveLate!({
            id: "m16",
            tag: handler.messageTag,
            payload: { settled: true },
        } as ResponseEnvelope);
        await vi.advanceTimersByTimeAsync(0);

        expect(postMessage).toHaveBeenCalledTimes(countAtStop);
    });

    it("does not throw and logs when the originating client (event.source) is null", async () => {
        const bus = await createAndInitBus({
            handlers: [handler],
            debug: true,
        });
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        handler.handleMessage.mockResolvedValueOnce({
            id: "m13",
            tag: handler.messageTag,
        } as ResponseEnvelope);

        await messageHandler({
            data: { id: "m13", tag: handler.messageTag },
            source: null,
            waitUntil: (p) => p,
        });

        expect(warnSpy).toHaveBeenCalled();
        const [msg] =
            warnSpy.mock.calls.find(
                (call) =>
                    typeof call[0] === "string" && call[0].includes("cannot deliver response"),
            ) ?? [];
        expect(msg).toBeDefined();

        warnSpy.mockRestore();
        await bus.stop();
    });

    it("broadcasts to every handler and acks handlers that return null", async () => {
        const handlerA = new TestHandler("A_HANDLER");
        const handlerB = new TestHandler("B_HANDLER");
        handlerA.handleMessage.mockResolvedValueOnce({
            id: "bc1",
            tag: "A_HANDLER",
            payload: { fromA: true },
        } as ResponseEnvelope);
        handlerB.handleMessage.mockResolvedValueOnce(null);

        const bus = await createAndInitBus({
            handlers: [handlerA, handlerB],
        });
        const postMessage = vi.fn();

        await messageHandler({
            data: { id: "bc1", tag: "BROADCAST", broadcast: true },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        expect(postMessage).toHaveBeenCalledTimes(2);
        // Order follows handler registration; A resolves with payload, B acks.
        expect(postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "bc1",
                tag: "A_HANDLER",
                payload: { fromA: true },
            }),
        );
        expect(postMessage).toHaveBeenCalledWith({
            id: "bc1",
            tag: "B_HANDLER",
        });

        await bus.stop();
    });

    it("surfaces per-handler errors in broadcast mode without suppressing others", async () => {
        const handlerA = new TestHandler("A_HANDLER");
        const handlerB = new TestHandler("B_HANDLER");
        handlerA.handleMessage.mockRejectedValueOnce(new Error("A failed"));
        handlerB.handleMessage.mockResolvedValueOnce({
            id: "bc2",
            tag: "B_HANDLER",
            payload: { ok: true },
        } as ResponseEnvelope);

        const bus = await createAndInitBus({
            handlers: [handlerA, handlerB],
        });
        const postMessage = vi.fn();

        await messageHandler({
            data: { id: "bc2", tag: "BROADCAST", broadcast: true },
            source: { postMessage },
            waitUntil: (p) => p,
        });

        expect(postMessage).toHaveBeenCalledTimes(2);
        const aResponse = postMessage.mock.calls.find(
            (c) => (c[0] as ResponseEnvelope).tag === "A_HANDLER",
        )?.[0] as ResponseEnvelope;
        expect(aResponse.error?.message).toBe("A failed");
        const bResponse = postMessage.mock.calls.find(
            (c) => (c[0] as ResponseEnvelope).tag === "B_HANDLER",
        )?.[0] as ResponseEnvelope;
        expect(bResponse.payload).toEqual({ ok: true });

        await bus.stop();
    });
});

describe("MessageBus init serialization (Iteration 1)", () => {
    beforeEach(() => {
        installSelfStub();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    function deferred<T>() {
        let resolve!: (value: T) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    }

    // Drain the microtask queue (and any chained continuations) by crossing a
    // macrotask boundary. These tests use real timers.
    const flush = () => new Promise<void>((r) => setTimeout(r, 0));

    const initConfig = {
        wallet: { publicKey: "00".repeat(33) },
        arkServer: { url: "http://localhost" },
    };

    function sendInit(id: string, source: { postMessage: (m: unknown) => void }) {
        return messageHandler({
            data: {
                type: "INITIALIZE_MESSAGE_BUS",
                id,
                tag: "INITIALIZE_MESSAGE_BUS",
                config: initConfig,
            } as never,
            source: source as never,
            waitUntil: (p: Promise<unknown>) => p,
        });
    }

    function sendMessage(id: string, tag: string, source: { postMessage: (m: unknown) => void }) {
        return messageHandler({
            data: { id, tag },
            source: source as never,
            waitUntil: (p: Promise<unknown>) => p,
        });
    }

    function makeBus(
        handlers: MessageHandler[],
        buildServices: () => Promise<unknown>,
    ): MessageBus {
        return new MessageBus(new InMemoryWalletRepository(), new InMemoryContractRepository(), {
            messageHandlers: handlers,
            buildServices: buildServices as never,
        });
    }

    it("runs concurrent inits FIFO: B does not build until A settles, and acks only after its handlers start", async () => {
        const handler = new TestHandler();
        const buildCalls: string[] = [];
        const gates = [deferred<unknown>(), deferred<unknown>()];
        let n = 0;
        const bus = makeBus([handler], () => {
            const i = n++;
            buildCalls.push(`build${i}`);
            return gates[i].promise;
        });
        await bus.start();

        const srcA = { postMessage: vi.fn() };
        const srcB = { postMessage: vi.fn() };
        const pA = sendInit("A", srcA);
        const pB = sendInit("B", srcB);

        // Only A's buildServices is running; B is queued behind it.
        await flush();
        expect(buildCalls).toEqual(["build0"]);
        expect(handler.start).not.toHaveBeenCalled();

        // A's build completes → A starts handlers and acks; only now B builds.
        gates[0].resolve({});
        await pA;
        await flush();
        expect(srcA.postMessage).toHaveBeenCalledWith({ id: "A", tag: "INITIALIZE_MESSAGE_BUS" });
        expect(buildCalls).toEqual(["build0", "build1"]);
        // B has not acked while its build is still pending.
        expect(srcB.postMessage).not.toHaveBeenCalled();

        gates[1].resolve({});
        await pB;
        expect(srcB.postMessage).toHaveBeenCalledWith({ id: "B", tag: "INITIALIZE_MESSAGE_BUS" });
        // B's handlers were started (re-init stop + start) before its ack.
        expect(handler.start).toHaveBeenCalledTimes(2);

        await bus.stop();
    });

    it("rejects ordinary wallet messages with MessageBusInitializingError while an init is pending", async () => {
        const handler = new TestHandler();
        const gates = [deferred<unknown>(), deferred<unknown>()];
        let n = 0;
        const bus = makeBus([handler], () => gates[n++].promise);
        await bus.start();

        const pA = sendInit("A", { postMessage: vi.fn() });
        gates[0].resolve({});
        await pA;

        // Begin B but leave its build pending: the bus is now unavailable.
        const pB = sendInit("B", { postMessage: vi.fn() });
        await flush();

        const srcM = { postMessage: vi.fn() };
        await sendMessage("m1", handler.messageTag, srcM);

        expect(handler.handleMessage).not.toHaveBeenCalled();
        const sent = srcM.postMessage.mock.calls[0][0] as ResponseEnvelope;
        expect(sent.id).toBe("m1");
        expect(sent.error).toBeInstanceOf(MessageBusInitializingError);

        gates[1].resolve({});
        await pB;
        await bus.stop();
    });

    it("stops existing handlers before starting new ones on re-init", async () => {
        const order: string[] = [];
        const handler = new TestHandler();
        handler.start.mockImplementation(async () => {
            order.push("start");
        });
        handler.stop.mockImplementation(async () => {
            order.push("stop");
        });
        const bus = makeBus([handler], async () => ({}));
        await bus.start();

        await sendInit("A", { postMessage: vi.fn() });
        await sendInit("B", { postMessage: vi.fn() });

        expect(order).toEqual(["start", "stop", "start"]);
        await bus.stop();
    });

    it("a failed init delivers an error and does not poison the next queued init", async () => {
        const handler = new TestHandler();
        let call = 0;
        const bus = makeBus([handler], async () => {
            if (call++ === 0) throw new Error("build boom");
            return {};
        });
        await bus.start();

        const srcA = { postMessage: vi.fn() };
        await sendInit("A", srcA);
        const aResp = srcA.postMessage.mock.calls[0][0] as ResponseEnvelope;
        expect(aResp.id).toBe("A");
        expect(aResp.error?.message).toBe("build boom");

        const srcB = { postMessage: vi.fn() };
        await sendInit("B", srcB);
        expect(srcB.postMessage).toHaveBeenCalledWith({ id: "B", tag: "INITIALIZE_MESSAGE_BUS" });

        // The bus is usable after the recovered init.
        handler.handleMessage.mockResolvedValueOnce({
            id: "m",
            tag: handler.messageTag,
            payload: { ok: true },
        } as ResponseEnvelope);
        const srcM = { postMessage: vi.fn() };
        await sendMessage("m", handler.messageTag, srcM);
        expect(srcM.postMessage.mock.calls[0][0]).toMatchObject({ payload: { ok: true } });

        await bus.stop();
    });

    it("after a successful init, a failed re-init rejects and wallet messages then report not-initialized", async () => {
        const handler = new TestHandler();
        let call = 0;
        const bus = makeBus([handler], async () => {
            if (call++ === 1) throw new Error("reinit boom");
            return {};
        });
        await bus.start();

        await sendInit("A", { postMessage: vi.fn() });
        const srcB = { postMessage: vi.fn() };
        await sendInit("B", srcB);
        expect((srcB.postMessage.mock.calls[0][0] as ResponseEnvelope).error?.message).toBe(
            "reinit boom",
        );

        const srcM = { postMessage: vi.fn() };
        await sendMessage("m", handler.messageTag, srcM);
        const sent = srcM.postMessage.mock.calls[0][0] as ResponseEnvelope;
        expect(sent.error).toBeInstanceOf(MessageBusNotInitializedError);
        expect(sent.error).not.toBeInstanceOf(MessageBusInitializingError);

        await bus.stop();
    });

    it("rolls back started handlers and stays unavailable when a later handler fails to start", async () => {
        const h1 = new TestHandler("H1");
        const h2 = new TestHandler("H2");
        h2.start.mockRejectedValueOnce(new Error("start boom"));
        const bus = makeBus([h1, h2], async () => ({}));
        await bus.start();

        const srcA = { postMessage: vi.fn() };
        await sendInit("A", srcA);

        // h1 started, h2 failed → h1 rolled back, init reported as failed.
        expect(h1.start).toHaveBeenCalledTimes(1);
        expect(h1.stop).toHaveBeenCalledTimes(1);
        expect((srcA.postMessage.mock.calls[0][0] as ResponseEnvelope).error?.message).toBe(
            "start boom",
        );

        // pendingInitCount returned to 0, so the bus reports not-initialized.
        const srcM = { postMessage: vi.fn() };
        await sendMessage("m", "H1", srcM);
        expect((srcM.postMessage.mock.calls[0][0] as ResponseEnvelope).error).toBeInstanceOf(
            MessageBusNotInitializedError,
        );

        await bus.stop();
    });

    it("delivers an init failure exactly once and resolves the init message (no unhandled throw)", async () => {
        const handler = new TestHandler();
        const bus = makeBus([handler], async () => {
            throw new Error("boom");
        });
        await bus.start();

        const src = { postMessage: vi.fn() };
        await expect(sendInit("X", src)).resolves.toBeUndefined();

        expect(src.postMessage).toHaveBeenCalledTimes(1);
        const sent = src.postMessage.mock.calls[0][0] as ResponseEnvelope;
        expect(sent).toMatchObject({ id: "X", tag: "INITIALIZE_MESSAGE_BUS" });
        expect(sent.error?.message).toBe("boom");

        await bus.stop();
    });

    it("MessageBusInitializingError is a not-initialized error with a superset message", () => {
        const e = new MessageBusInitializingError();
        // Backward compatibility: instanceof and the substring detector both
        // still classify the pending variant as not-initialized.
        expect(e).toBeInstanceOf(MessageBusNotInitializedError);
        expect(e.message.includes(MESSAGE_BUS_NOT_INITIALIZED)).toBe(true);
        // The more specific marker distinguishes it for opt-in callers.
        expect(e.message.includes(MESSAGE_BUS_INITIALIZING)).toBe(true);
        expect(new MessageBusNotInitializedError().message.includes(MESSAGE_BUS_INITIALIZING)).toBe(
            false,
        );
    });
});
