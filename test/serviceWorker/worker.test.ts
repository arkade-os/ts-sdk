import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    Worker,
    type IUpdater,
    type RequestEnvelope,
    type ResponseEnvelope,
} from "../../src/serviceWorker/worker";

type TestUpdater = IUpdater<RequestEnvelope, ResponseEnvelope>;

type SelfMock = {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    setTimeout: ReturnType<typeof vi.fn>;
    clearTimeout: ReturnType<typeof vi.fn>;
    clients: {
        matchAll: ReturnType<typeof vi.fn>;
        claim: ReturnType<typeof vi.fn>;
    };
    skipWaiting: ReturnType<typeof vi.fn>;
};

const createSelfMock = () => {
    const listeners = new Map<string, ((event: any) => void)[]>();
    const timeouts = new Map<number, () => void>();
    const activeTimeouts = new Set<number>();
    let nextId = 1;

    const selfMock: SelfMock = {
        addEventListener: vi.fn((type: string, cb: (event: any) => void) => {
            const existing = listeners.get(type) || [];
            existing.push(cb);
            listeners.set(type, existing);
        }),
        removeEventListener: vi.fn((type: string, cb: (event: any) => void) => {
            const existing = listeners.get(type) || [];
            listeners.set(
                type,
                existing.filter((handler) => handler !== cb)
            );
        }),
        setTimeout: vi.fn((fn: () => void) => {
            const id = nextId++;
            timeouts.set(id, fn);
            activeTimeouts.add(id);
            return id as unknown as number;
        }),
        clearTimeout: vi.fn((id: number) => {
            activeTimeouts.delete(id);
            timeouts.delete(id);
        }),
        clients: {
            matchAll: vi.fn().mockResolvedValue([]),
            claim: vi.fn(),
        },
        skipWaiting: vi.fn(),
    };

    return { selfMock, listeners, timeouts, activeTimeouts };
};

describe("Worker", () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("routes messages to the matching updater and replies to the sender", async () => {
        const { selfMock, listeners } = createSelfMock();
        vi.stubGlobal("self", selfMock as any);

        const handleRequest = vi
            .fn()
            .mockResolvedValue({ sourceTag: "wallet", id: "1" });

        const updater: TestUpdater = {
            messageTag: "wallet",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([]),
            handleRequest,
        };

        const sw = new Worker({ updaters: [updater] });
        await sw.start();

        const messageHandlers = listeners.get("message") || [];
        expect(messageHandlers.length).toBe(1);

        const source = { postMessage: vi.fn() };
        await messageHandlers[0]({
            data: { id: "1", targetTag: "wallet" },
            source,
        });

        expect(handleRequest).toHaveBeenCalledWith({
            id: "1",
            targetTag: "wallet",
        });
        expect(source.postMessage).toHaveBeenCalledWith({
            sourceTag: "wallet",
            id: "1",
        });
    });

    it("ignores messages with unknown tags", async () => {
        const { selfMock, listeners } = createSelfMock();
        vi.stubGlobal("self", selfMock as any);

        const handleRequest = vi.fn().mockResolvedValue(null);
        const updater: TestUpdater = {
            messageTag: "known",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([]),
            handleRequest,
        };

        const sw = new Worker({ updaters: [updater] });
        await sw.start();

        const messageHandlers = listeners.get("message") || [];
        const source = { postMessage: vi.fn() };
        await messageHandlers[0]({
            data: { id: "1", targetTag: "unknown" },
            source,
        });

        expect(handleRequest).not.toHaveBeenCalled();
        expect(source.postMessage).not.toHaveBeenCalled();
    });

    it("keeps a single scheduled tick while rescheduling", async () => {
        const { selfMock, activeTimeouts } = createSelfMock();
        vi.stubGlobal("self", selfMock as any);

        const updater: TestUpdater = {
            messageTag: "wallet",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([]),
            handleRequest: vi.fn().mockResolvedValue(null),
        };

        const sw = new Worker({ updaters: [updater], tickIntervalMs: 10 });
        await sw.start();

        const [firstId] = Array.from(activeTimeouts);
        expect(activeTimeouts.size).toBe(1);

        await (sw as any).runTick();

        expect(selfMock.clearTimeout).toHaveBeenCalledWith(firstId);
        expect(activeTimeouts.size).toBe(1);
    });

    it("prevents concurrent tick runs", async () => {
        const { selfMock } = createSelfMock();
        vi.stubGlobal("self", selfMock as any);

        let resolveTick: (() => void) | undefined;
        const tickPromise = new Promise<void>((resolve) => {
            resolveTick = resolve;
        });

        const updater: TestUpdater = {
            messageTag: "wallet",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockReturnValue(tickPromise),
            handleRequest: vi.fn().mockResolvedValue(null),
        };

        const sw = new Worker({ updaters: [updater] });
        await sw.start();

        const firstRun = (sw as any).runTick();
        await (sw as any).runTick();

        expect(updater.tick).toHaveBeenCalledTimes(1);

        resolveTick?.();
        await firstRun;
    });

    it("broadcasts client messages to all updaters", async () => {
        const { selfMock, listeners } = createSelfMock();
        vi.stubGlobal("self", selfMock as any);

        const updaterA: TestUpdater = {
            messageTag: "a",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([]),
            handleRequest: vi.fn().mockResolvedValue({
                sourceTag: "a",
                id: "1",
            }),
        };
        const updaterB: TestUpdater = {
            messageTag: "b",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([]),
            handleRequest: vi.fn().mockResolvedValue({
                sourceTag: "b",
                id: "1",
            }),
        };

        const sw = new Worker({ updaters: [updaterA, updaterB] });
        await sw.start();

        const messageHandlers = listeners.get("message") || [];
        const source = { postMessage: vi.fn() };
        const payload = {
            id: "1",
            targetTag: "broadcast",
            broadcast: true,
        };

        await messageHandlers[0]({ data: payload, source });

        expect(updaterA.handleRequest).toHaveBeenCalledWith(payload);
        expect(updaterB.handleRequest).toHaveBeenCalledWith(payload);
        expect(source.postMessage).toHaveBeenCalledWith({
            sourceTag: "a",
            id: "1",
        });
        expect(source.postMessage).toHaveBeenCalledWith({
            sourceTag: "b",
            id: "1",
        });
    });

    it("broadcasts tick responses to all clients", async () => {
        const { selfMock } = createSelfMock();
        const clientA = { postMessage: vi.fn() };
        const clientB = { postMessage: vi.fn() };
        selfMock.clients.matchAll.mockResolvedValue([clientA, clientB]);
        vi.stubGlobal("self", selfMock as any);

        const updater: TestUpdater = {
            messageTag: "wallet",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([
                {
                    sourceTag: "wallet",
                    id: "broadcast",
                    broadcast: true,
                },
            ]),
            handleRequest: vi.fn().mockResolvedValue(null),
        };

        const sw = new Worker({ updaters: [updater] });
        await sw.start();
        await (sw as any).runTick();

        expect(selfMock.clients.matchAll).toHaveBeenCalledWith({
            includeUncontrolled: true,
            type: "window",
        });
        expect(clientA.postMessage).toHaveBeenCalledWith({
            sourceTag: "wallet",
            id: "broadcast",
            broadcast: true,
        });
        expect(clientB.postMessage).toHaveBeenCalledWith({
            sourceTag: "wallet",
            id: "broadcast",
            broadcast: true,
        });
    });

    // Tick routing: A emits a request to B, B responds, A consumes via handleResponse and emits a broadcast response.
    it("routes tick requests between updaters and allows origin to emit a broadcast response", async () => {
        const { selfMock } = createSelfMock();
        const client = { postMessage: vi.fn() };
        selfMock.clients.matchAll.mockResolvedValue([client]);
        vi.stubGlobal("self", selfMock as any);

        const request = {
            id: "req-1",
            targetTag: "B",
            sourceTag: "A",
        };
        const responseFromB = {
            id: "req-1",
            sourceTag: "B",
        };

        const updaterA: TestUpdater = {
            messageTag: "A",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([request]),
            handleRequest: vi.fn().mockResolvedValue(null),
            handleResponse: vi.fn().mockResolvedValue({
                id: "final",
                sourceTag: "A",
                broadcast: true,
            }),
        };
        const updaterB: TestUpdater = {
            messageTag: "B",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([]),
            handleRequest: vi.fn().mockResolvedValue(responseFromB),
        };

        const sw = new Worker({
            updaters: [updaterA, updaterB],
            maxRouteIterations: 3,
        });
        await sw.start();
        await (sw as any).runTick();

        expect(updaterB.handleRequest).toHaveBeenCalledWith(request);
        expect(updaterA.handleResponse).toHaveBeenCalledWith(responseFromB);
        expect(client.postMessage).toHaveBeenCalledWith({
            id: "final",
            sourceTag: "A",
            broadcast: true,
        });
    });

    // Client routing: client message to A, A returns request to B, B responds, A returns final response to the client.
    it("routes a client request through another updater and returns the final response", async () => {
        const { selfMock, listeners } = createSelfMock();
        vi.stubGlobal("self", selfMock as any);

        const updaterA: TestUpdater = {
            messageTag: "A",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([]),
            handleRequest: vi.fn().mockResolvedValue({
                id: "req-1",
                targetTag: "B",
                sourceTag: "A",
            }),
            handleResponse: vi.fn().mockResolvedValue({
                id: "req-1",
                sourceTag: "A",
            }),
        };
        const updaterB: TestUpdater = {
            messageTag: "B",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([]),
            handleRequest: vi.fn().mockResolvedValue({
                id: "req-1",
                sourceTag: "B",
            }),
        };

        const sw = new Worker({ updaters: [updaterA, updaterB] });
        await sw.start();

        const messageHandlers = listeners.get("message") || [];
        const source = { postMessage: vi.fn() };
        await messageHandlers[0]({
            data: { id: "req-1", targetTag: "A" },
            source,
        });

        expect(updaterA.handleRequest).toHaveBeenCalledWith({
            id: "req-1",
            targetTag: "A",
        });
        expect(updaterB.handleRequest).toHaveBeenCalledWith({
            id: "req-1",
            targetTag: "B",
            sourceTag: "A",
        });
        expect(updaterA.handleResponse).toHaveBeenCalledWith({
            id: "req-1",
            sourceTag: "B",
        });
        expect(source.postMessage).toHaveBeenCalledWith({
            id: "req-1",
            sourceTag: "A",
        });
    });
});
