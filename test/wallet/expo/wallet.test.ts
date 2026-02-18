import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryTaskQueue } from "../../../src/worker/expo/taskQueue";
import { CONTRACT_POLL_TASK_TYPE } from "../../../src/worker/expo/processors";

const walletCreateMock = vi.fn();
const runTasksMock = vi.fn();
const registerExpoBackgroundTaskMock = vi.fn();
const unregisterExpoBackgroundTaskMock = vi.fn();

vi.mock("../../../src/wallet/wallet", () => ({
    Wallet: {
        create: walletCreateMock,
    },
}));

vi.mock("../../../src/worker/expo/taskRunner", async () => {
    const actual = await vi.importActual<any>(
        "../../../src/worker/expo/taskRunner"
    );
    return {
        ...actual,
        runTasks: runTasksMock,
    };
});

vi.mock("../../../src/wallet/expo/background", () => ({
    registerExpoBackgroundTask: registerExpoBackgroundTaskMock,
    unregisterExpoBackgroundTask: unregisterExpoBackgroundTaskMock,
}));

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
    sendBitcoin: vi.fn().mockResolvedValue("send-txid"),
    settle: vi.fn().mockResolvedValue("settle-txid"),
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

    it("setup persists background config, seeds tasks, and registers background task", async () => {
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
                taskName: "ark-background-poll",
                taskQueue: taskQueue as any,
                minimumBackgroundInterval: 20,
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
        expect(await taskQueue.getTasks(CONTRACT_POLL_TASK_TYPE)).toHaveLength(
            1
        );
        expect(registerExpoBackgroundTaskMock).toHaveBeenCalledWith(
            "ark-background-poll",
            {
                minimumInterval: 20,
            }
        );

        await wallet.dispose();
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
                taskName: "ark-foreground-poll",
                taskQueue,
                foregroundIntervalMs: 1_000,
            },
        } as any);

        expect(await taskQueue.getTasks(CONTRACT_POLL_TASK_TYPE)).toHaveLength(
            1
        );

        await vi.advanceTimersByTimeAsync(1_000);

        expect(runTasksMock).toHaveBeenCalledTimes(1);
        expect(await taskQueue.getResults()).toEqual([]);
        expect(await taskQueue.getTasks(CONTRACT_POLL_TASK_TYPE)).toHaveLength(
            1
        );

        await wallet.dispose();
        const callsBefore = runTasksMock.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(runTasksMock).toHaveBeenCalledTimes(callsBefore);
        expect(unregisterExpoBackgroundTaskMock).toHaveBeenCalledWith(
            "ark-foreground-poll"
        );
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
                taskName: "ark-delegation",
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
        await expect(wallet.getBoardingUtxos()).resolves.toEqual([
            { txid: "u1" },
        ]);
        await expect(wallet.getTransactionHistory()).resolves.toEqual([
            { txid: "h1" },
        ]);
        await expect(wallet.getContractManager()).resolves.toEqual({
            id: "manager",
        });
        await expect(wallet.sendBitcoin({ amount: 1 } as any)).resolves.toBe(
            "send-txid"
        );
        await expect(wallet.settle()).resolves.toBe("settle-txid");

        expect(walletStub.getAddress).toHaveBeenCalledTimes(1);
        expect(walletStub.getBoardingAddress).toHaveBeenCalledTimes(1);
        expect(walletStub.getBalance).toHaveBeenCalledTimes(1);
        expect(walletStub.getVtxos).toHaveBeenCalledTimes(1);
        expect(walletStub.getBoardingUtxos).toHaveBeenCalledTimes(1);
        expect(walletStub.getTransactionHistory).toHaveBeenCalledTimes(1);
        expect(walletStub.getContractManager).toHaveBeenCalledTimes(1);
        expect(walletStub.sendBitcoin).toHaveBeenCalledWith({ amount: 1 });
        expect(walletStub.settle).toHaveBeenCalledTimes(1);

        await wallet.dispose();
        expect(unregisterExpoBackgroundTaskMock).toHaveBeenCalledWith(
            "ark-delegation"
        );
    });
});
