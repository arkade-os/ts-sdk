import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    MessageBus,
    type MessageHandler,
    type RequestEnvelope,
    type ResponseEnvelope,
} from "../../src/worker/messageBus";
import {
    InMemoryContractRepository,
    InMemoryWalletRepository,
} from "../../src";

type TestUpdater = MessageHandler<RequestEnvelope, ResponseEnvelope>;

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

const defaultInitConfig = {
    wallet: {
        privateKey:
            "153cd1982d6704b26da1a4a91baee0c27aeb7ada019adec2ea2ce5c4e717f99c",
    },
    arkServer: {
        url: "https://ark.example.test",
        publicKey: "initConfig.arkServerPublicKey",
    },
};

describe("Worker", () => {
    let selfMock: SelfMock;
    let listeners: Map<string, ((event: any) => void)[]>;

    beforeEach(() => {
        vi.resetAllMocks();
        ({ selfMock, listeners } = createSelfMock());
        vi.stubGlobal("self", selfMock as any);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const initializeMessageBus = async (
        config = defaultInitConfig
    ): Promise<{ source: { postMessage: ReturnType<typeof vi.fn> } }> => {
        const messageHandlers = listeners.get("message") || [];
        expect(messageHandlers.length).toBeGreaterThan(0);

        const source = { postMessage: vi.fn() };
        await messageHandlers[0]({
            data: {
                tag: "INITIALIZE_MESSAGE_BUS",
                id: "init",
                config,
            },
            source,
        });

        return { source };
    };

    it("routes messages to the matching updater and replies to the sender", async () => {
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

        const sw = new MessageBus(
            new InMemoryWalletRepository(),
            new InMemoryContractRepository(),
            {
                messageHandlers: [updater],
                buildServices: async () => ({
                    arkProvider: {} as any,
                    readonlyWallet: {} as any,
                }),
            }
        );
        await sw.start();
        await initializeMessageBus();

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
        const handleMessage = vi.fn().mockResolvedValue(null);
        const updater: TestUpdater = {
            messageTag: "known",
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([]),
            handleMessage,
        };

        const sw = new MessageBus(
            new InMemoryWalletRepository(),
            new InMemoryContractRepository(),
            {
                messageHandlers: [updater],
                buildServices: async () => ({
                    arkProvider: {} as any,
                    readonlyWallet: {} as any,
                }),
            }
        );
        await sw.start();
        await initializeMessageBus();

        const messageHandlers = listeners.get("message") || [];
        const source = { postMessage: vi.fn() };
        await messageHandlers[0]({
            data: { id: "1", tag: "unknown" },
            source,
        });

        expect(handleMessage).not.toHaveBeenCalled();
        expect(source.postMessage).not.toHaveBeenCalled();
    });

    it("handles init message", async () => {
        const updater: TestUpdater = {
            messageTag: "wallet",
            start: vi.fn().mockResolvedValue([]),
            stop: vi.fn().mockResolvedValue(undefined),
            tick: vi.fn().mockResolvedValue([]),
            handleMessage: vi.fn().mockResolvedValue(null),
        };

        const config = {
            wallet: {
                privateKey:
                    "153cd1982d6704b26da1a4a91baee0c27aeb7ada019adec2ea2ce5c4e717f99c",
            },
            arkServer: {
                url: "initConfig.arkServerUrl",
                publicKey: "initConfig.arkServerPublicKey",
            },
        };

        const buildServicesSpy = vi.fn(async () => ({
            arkProvider: {} as any,
            readonlyWallet: {} as any,
        }));
        const walletRepository = new InMemoryWalletRepository();
        const sw = new MessageBus(
            walletRepository,
            new InMemoryContractRepository(),
            {
                messageHandlers: [updater],
                tickIntervalMs: 10,
                buildServices: buildServicesSpy,
            }
        );
        await sw.start();

        const messageHandlers = listeners.get("message") || [];
        expect(messageHandlers.length).toBe(1);

        const source = { postMessage: vi.fn() };
        await messageHandlers[0]({
            data: {
                tag: "INITIALIZE_MESSAGE_BUS",
                id: "abc-def",
                config,
            },
            source,
        });

        expect(buildServicesSpy).toHaveBeenCalledExactlyOnceWith(config);
        expect(updater.start).toHaveBeenCalledExactlyOnceWith(
            {
                arkProvider: {},
                readonlyWallet: {},
            },
            { walletRepository }
        );
    });

    it("prevents concurrent tick runs", async () => {
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

        const sw = new MessageBus(
            new InMemoryWalletRepository(),
            new InMemoryContractRepository(),
            { messageHandlers: [updater] }
        );
        await sw.start();

        const firstRun = (sw as any).runTick();
        await (sw as any).runTick();

        expect(updater.tick).toHaveBeenCalledTimes(1);

        resolveTick?.();
        await firstRun;
    });

    it("broadcasts client messages to all updaters", async () => {
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

        const sw = new MessageBus(
            new InMemoryWalletRepository(),
            new InMemoryContractRepository(),
            {
                messageHandlers: [updaterA, updaterB],
                buildServices: async () => ({
                    arkProvider: {} as any,
                    readonlyWallet: {} as any,
                }),
            }
        );
        await sw.start();
        await initializeMessageBus();

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
        const clientA = { postMessage: vi.fn() };
        const clientB = { postMessage: vi.fn() };
        selfMock.clients.matchAll.mockResolvedValue([clientA, clientB]);

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

        const sw = new MessageBus(
            new InMemoryWalletRepository(),
            new InMemoryContractRepository(),
            {
                messageHandlers: [updater],
            }
        );
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
