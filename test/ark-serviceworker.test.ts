import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    Worker,
    type IUpdater,
    type RequestEnvelope,
    type ResponseEnvelope,
} from "../src/serviceWorker/worker";

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

describe("ArkSW", () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("routes messages to the matching updater and replies to the sender", async () => {
        const { selfMock, listeners } = createSelfMock();
        vi.stubGlobal("self", selfMock as any);

        const handleMessage = vi
            .fn()
            .mockResolvedValue({ tag: "wallet", id: "1" });

        const updater: TestUpdater = {
            messageTag: "wallet",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([]),
            handleMessage,
        };

        const sw = new Worker({ updaters: [updater] });
        await sw.start();

        const messageHandlers = listeners.get("message") || [];
        expect(messageHandlers.length).toBe(1);

        const source = { postMessage: vi.fn() };
        await messageHandlers[0]({
            data: { id: "1", tag: "wallet" },
            source,
        });

        expect(handleMessage).toHaveBeenCalledWith({ id: "1", tag: "wallet" });
        expect(source.postMessage).toHaveBeenCalledWith({
            tag: "wallet",
            id: "1",
        });
    });

    it("ignores messages with unknown tags", async () => {
        const { selfMock, listeners } = createSelfMock();
        vi.stubGlobal("self", selfMock as any);

        const handleMessage = vi.fn().mockResolvedValue(null);
        const updater: TestUpdater = {
            messageTag: "known",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([]),
            handleMessage,
        };

        const sw = new Worker({ updaters: [updater] });
        await sw.start();

        const messageHandlers = listeners.get("message") || [];
        const source = { postMessage: vi.fn() };
        await messageHandlers[0]({
            data: { id: "1", tag: "unknown" },
            source,
        });

        expect(handleMessage).not.toHaveBeenCalled();
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
            handleMessage: vi.fn().mockResolvedValue(null),
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
            handleMessage: vi.fn().mockResolvedValue(null),
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
            handleMessage: vi.fn().mockResolvedValue({ tag: "a", id: "1" }),
        };
        const updaterB: TestUpdater = {
            messageTag: "b",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([]),
            handleMessage: vi.fn().mockResolvedValue({ tag: "b", id: "1" }),
        };

        const sw = new Worker({ updaters: [updaterA, updaterB] });
        await sw.start();

        const messageHandlers = listeners.get("message") || [];
        const source = { postMessage: vi.fn() };
        const payload = { id: "1", tag: "broadcast", broadcast: true };

        await messageHandlers[0]({ data: payload, source });

        expect(updaterA.handleMessage).toHaveBeenCalledWith(payload);
        expect(updaterB.handleMessage).toHaveBeenCalledWith(payload);
        expect(source.postMessage).toHaveBeenCalledWith({ tag: "a", id: "1" });
        expect(source.postMessage).toHaveBeenCalledWith({ tag: "b", id: "1" });
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
            tick: vi
                .fn()
                .mockResolvedValue([
                    { tag: "wallet", id: "broadcast", broadcast: true },
                ]),
            handleMessage: vi.fn().mockResolvedValue(null),
        };

        const sw = new Worker({ updaters: [updater] });
        await sw.start();
        await (sw as any).runTick();

        expect(selfMock.clients.matchAll).toHaveBeenCalledWith({
            includeUncontrolled: true,
            type: "window",
        });
        expect(clientA.postMessage).toHaveBeenCalledWith({
            tag: "wallet",
            id: "broadcast",
            broadcast: true,
        });
        expect(clientB.postMessage).toHaveBeenCalledWith({
            tag: "wallet",
            id: "broadcast",
            broadcast: true,
        });
    });
});
