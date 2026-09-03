import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryTaskQueue } from "../../../src/worker/expo/taskQueue";
import { CONTRACT_POLL_TASK_TYPE } from "../../../src/worker/expo/processors";

const walletCreateMock = vi.fn();
const runTasksMock = vi.fn();

vi.mock("../../../src/wallet/wallet", () => ({
    Wallet: {
        create: walletCreateMock,
    },
}));

vi.mock("../../../src/worker/expo/taskRunner", async () => {
    const actual = await vi.importActual<any>("../../../src/worker/expo/taskRunner");
    return {
        ...actual,
        runTasks: runTasksMock,
    };
});

const loadExpoWallet = async () => import("../../../src/wallet/expo/wallet");

const createWalletStub = () => ({
    identity: { kind: "test-identity" },
    arkProvider: { name: "ark-provider" },
    indexerProvider: { name: "indexer-provider" },
    walletRepository: { name: "wallet-repo" },
    contractRepository: { name: "contract-repo" },
    offchainTapscript: {
        options: {
            pubKey: Uint8Array.from([1, 2, 3]),
            serverPubKey: Uint8Array.from([4, 5, 6]),
            csvTimelock: { value: 77n, type: "blocks" as const },
        },
    },
    getAddress: vi.fn().mockResolvedValue("arkade1-address"),
    getBoardingAddress: vi.fn().mockResolvedValue("bc1-boarding"),
    getBalance: vi.fn().mockResolvedValue({ offchain: 1, onchain: 2 }),
    getVtxos: vi.fn().mockResolvedValue([{ txid: "v1" }]),
    getBoardingUtxos: vi.fn().mockResolvedValue([{ txid: "u1" }]),
    getTransactionHistory: vi.fn().mockResolvedValue([{ txid: "h1" }]),
    getContractManager: vi.fn().mockResolvedValue({ id: "manager" }),
    getProviderConnectionState: vi
        .fn()
        .mockReturnValue({ mode: "degraded", source: "cache", provider: "arkade", reason: "down" }),
    getDelegateManager: vi.fn().mockResolvedValue({ id: "delegate" }),
    sendBitcoin: vi.fn().mockResolvedValue("send-txid"),
    settle: vi.fn().mockResolvedValue("settle-txid"),
    dispose: vi.fn().mockResolvedValue(undefined),
});

class QueueWithConfig extends InMemoryTaskQueue {
    persistConfig = vi.fn(async () => undefined);
}

describe("ExpoWallet", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("setup persists background config and seeds tasks", async () => {
        const taskQueue = new QueueWithConfig();
        const walletStub = createWalletStub();
        walletCreateMock.mockResolvedValue(walletStub);

        const { ExpoWallet } = await loadExpoWallet();

        const wallet = await ExpoWallet.setup({
            identity: {} as any,
            arkServerUrl: "https://ark.example",
            esploraUrl: "https://esplora.example",
            storage: {} as any,
            background: {
                taskQueue: taskQueue as any,
            },
        } as any);

        expect(walletCreateMock).toHaveBeenCalledTimes(1);
        expect(taskQueue.persistConfig).toHaveBeenCalledWith({
            arkServerUrl: "https://ark.example",
            pubkeyHex: "010203",
            serverPubKeyHex: "040506",
            exitTimelockValue: "77",
            exitTimelockType: "blocks",
        });
        expect(await taskQueue.getTasks(CONTRACT_POLL_TASK_TYPE)).toHaveLength(1);

        await wallet.dispose();
        expect(walletStub.dispose).toHaveBeenCalledTimes(1);
    });

    it("foreground polling runs tasks, acknowledges results, and reseeds", async () => {
        vi.useFakeTimers();

        const taskQueue = new InMemoryTaskQueue();
        const walletStub = createWalletStub();
        walletCreateMock.mockResolvedValue(walletStub);

        runTasksMock.mockImplementation(async (queue: InMemoryTaskQueue) => {
            const tasks = await queue.getTasks();
            for (const task of tasks) {
                await queue.removeTask(task.id);
            }
            await queue.pushResult({
                id: "result-1",
                taskItemId: "task-1",
                type: CONTRACT_POLL_TASK_TYPE,
                status: "success",
                executedAt: Date.now(),
            });
            return await queue.getResults();
        });

        const { ExpoWallet } = await loadExpoWallet();

        const wallet = await ExpoWallet.setup({
            identity: {} as any,
            arkServerUrl: "https://ark.example",
            esploraUrl: "https://esplora.example",
            storage: {} as any,
            background: {
                taskQueue,
                foregroundIntervalMs: 1_000,
            },
        } as any);

        expect(await taskQueue.getTasks(CONTRACT_POLL_TASK_TYPE)).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1_000);

        expect(runTasksMock).toHaveBeenCalledTimes(1);
        expect(await taskQueue.getResults()).toEqual([]);
        expect(await taskQueue.getTasks(CONTRACT_POLL_TASK_TYPE)).toHaveLength(1);

        await wallet.dispose();
        expect(walletStub.dispose).toHaveBeenCalledTimes(1);
        const callsBefore = runTasksMock.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(runTasksMock).toHaveBeenCalledTimes(callsBefore);
    });

    it("delegates wallet methods to the inner wallet", async () => {
        const taskQueue = new InMemoryTaskQueue();
        const walletStub = createWalletStub();
        walletCreateMock.mockResolvedValue(walletStub);

        const { ExpoWallet } = await loadExpoWallet();

        const wallet = await ExpoWallet.setup({
            identity: {} as any,
            arkServerUrl: "https://ark.example",
            esploraUrl: "https://esplora.example",
            storage: {} as any,
            background: {
                taskQueue,
            },
        } as any);

        await expect(wallet.getAddress()).resolves.toBe("arkade1-address");
        await expect(wallet.getBoardingAddress()).resolves.toBe("bc1-boarding");
        await expect(wallet.getBalance()).resolves.toEqual({
            offchain: 1,
            onchain: 2,
        });
        await expect(wallet.getVtxos()).resolves.toEqual([{ txid: "v1" }]);
        await expect(wallet.getBoardingUtxos()).resolves.toEqual([{ txid: "u1" }]);
        await expect(wallet.getTransactionHistory()).resolves.toEqual([{ txid: "h1" }]);
        await expect(wallet.getContractManager()).resolves.toEqual({
            id: "manager",
        });
        expect(wallet.getProviderConnectionState()).toEqual({
            mode: "degraded",
            source: "cache",
            provider: "arkade",
            reason: "down",
        });
        await expect(wallet.getDelegateManager()).resolves.toEqual({
            id: "delegate",
        });
        await expect(wallet.sendBitcoin({ amount: 1 } as any)).resolves.toBe("send-txid");
        await expect(wallet.settle()).resolves.toBe("settle-txid");

        expect(walletStub.getAddress).toHaveBeenCalledTimes(1);
        expect(walletStub.getBoardingAddress).toHaveBeenCalledTimes(1);
        expect(walletStub.getBalance).toHaveBeenCalledTimes(1);
        expect(walletStub.getVtxos).toHaveBeenCalledTimes(1);
        expect(walletStub.getBoardingUtxos).toHaveBeenCalledTimes(1);
        expect(walletStub.getTransactionHistory).toHaveBeenCalledTimes(1);
        expect(walletStub.getContractManager).toHaveBeenCalledTimes(1);
        expect(walletStub.getProviderConnectionState).toHaveBeenCalledTimes(1);
        expect(walletStub.getDelegateManager).toHaveBeenCalledTimes(1);
        expect(walletStub.sendBitcoin).toHaveBeenCalledWith({ amount: 1 });
        expect(walletStub.settle).toHaveBeenCalledTimes(1);

        await wallet.dispose();
        expect(walletStub.dispose).toHaveBeenCalledTimes(1);
    });
});

describe("warnOnRemovedBackgroundFields", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it("does not warn when neither removed field is present", async () => {
        const { warnOnRemovedBackgroundFields } = await loadExpoWallet();
        warnOnRemovedBackgroundFields({
            taskQueue: {},
            foregroundIntervalMs: 20_000,
        });
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns and names taskName when present (pre-fix-#486 field)", async () => {
        const { warnOnRemovedBackgroundFields } = await loadExpoWallet();
        warnOnRemovedBackgroundFields({
            taskName: "ark-background-poll",
            taskQueue: {},
        });
        expect(warnSpy).toHaveBeenCalledOnce();
        const msg = String(warnSpy.mock.calls[0][0]);
        expect(msg).toContain("taskName");
        expect(msg).toContain("@arkade-os/sdk/wallet/expo/background");
    });

    it("warns and names minimumBackgroundInterval when present", async () => {
        const { warnOnRemovedBackgroundFields } = await loadExpoWallet();
        warnOnRemovedBackgroundFields({
            taskQueue: {},
            minimumBackgroundInterval: 15,
        });
        expect(warnSpy).toHaveBeenCalledOnce();
        const msg = String(warnSpy.mock.calls[0][0]);
        expect(msg).toContain("minimumBackgroundInterval");
    });

    it("lists both removed fields in a single warning when both present", async () => {
        const { warnOnRemovedBackgroundFields } = await loadExpoWallet();
        warnOnRemovedBackgroundFields({
            taskName: "ark-background-poll",
            minimumBackgroundInterval: 15,
            taskQueue: {},
        });
        expect(warnSpy).toHaveBeenCalledOnce();
        const msg = String(warnSpy.mock.calls[0][0]);
        expect(msg).toContain("taskName");
        expect(msg).toContain("minimumBackgroundInterval");
    });

    it("does not throw on null / undefined / non-object inputs", async () => {
        const { warnOnRemovedBackgroundFields } = await loadExpoWallet();
        expect(() => warnOnRemovedBackgroundFields(null)).not.toThrow();
        expect(() => warnOnRemovedBackgroundFields(undefined)).not.toThrow();
        expect(() => warnOnRemovedBackgroundFields("nonsense")).not.toThrow();
        expect(warnSpy).not.toHaveBeenCalled();
    });
});
