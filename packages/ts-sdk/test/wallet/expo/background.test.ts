import Module from "module";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CONTRACT_POLL_TASK_TYPE } from "../../../src/worker/expo/processors";

const defineTaskMock = vi.fn();
const registerTaskAsyncMock = vi.fn();
const unregisterTaskAsyncMock = vi.fn();
const runTasksMock = vi.fn();
const expoIndexerProviderCtorMock = vi.fn();
const expoArkProviderCtorMock = vi.fn();

vi.mock("../../../src/worker/expo/taskRunner", async () => {
    const actual = await vi.importActual<any>(
        "../../../src/worker/expo/taskRunner"
    );
    return {
        ...actual,
        runTasks: runTasksMock,
    };
});

vi.mock("../../../src/providers/expoIndexer", () => ({
    ExpoIndexerProvider: function (this: any, serverUrl: string) {
        expoIndexerProviderCtorMock(serverUrl);
        this.serverUrl = serverUrl;
    },
}));

vi.mock("../../../src/providers/expoArk", () => ({
    ExpoArkProvider: function (this: any, serverUrl: string) {
        expoArkProviderCtorMock(serverUrl);
        this.serverUrl = serverUrl;
    },
}));

const loadBackground = async () =>
    import("../../../src/wallet/expo/background");

describe("expo background task helpers", () => {
    const originalRequire = Module.prototype.require;

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();

        Module.prototype.require = function patchedRequire(
            this: unknown,
            id: string
        ) {
            if (id === "expo-task-manager") {
                return {
                    defineTask: defineTaskMock,
                };
            }
            if (id === "expo-background-task") {
                return {
                    BackgroundTaskResult: { Success: 1, Failed: 2 },
                    registerTaskAsync: registerTaskAsyncMock,
                    unregisterTaskAsync: unregisterTaskAsyncMock,
                };
            }
            return originalRequire.call(this, id);
        };
    });

    afterEach(() => {
        Module.prototype.require = originalRequire;
    });

    it("defines and executes the background task happy path", async () => {
        const taskQueue = {
            loadConfig: vi.fn().mockResolvedValue({
                arkServerUrl: "https://ark.example",
                pubkeyHex: "01".repeat(32),
                serverPubKeyHex: "02".repeat(32),
                exitTimelockValue: "77",
                exitTimelockType: "blocks",
            }),
            getResults: vi.fn().mockResolvedValue([{ id: "result-1" }]),
            acknowledgeResults: vi.fn().mockResolvedValue(undefined),
            getTasks: vi.fn().mockResolvedValue([]),
            addTask: vi.fn().mockResolvedValue(undefined),
        };
        const walletRepository = { id: "wallet-repository" };
        const contractRepository = { id: "contract-repository" };
        runTasksMock.mockResolvedValue([]);

        const { defineExpoBackgroundTask } = await loadBackground();

        defineExpoBackgroundTask("ark-background-task", {
            taskQueue: taskQueue as any,
            walletRepository: walletRepository as any,
            contractRepository: contractRepository as any,
        });

        expect(defineTaskMock).toHaveBeenCalledTimes(1);
        expect(defineTaskMock).toHaveBeenCalledWith(
            "ark-background-task",
            expect.any(Function)
        );

        const executor = defineTaskMock.mock.calls[0][1];
        const result = await executor();

        expect(expoIndexerProviderCtorMock).toHaveBeenCalledWith(
            "https://ark.example"
        );
        expect(expoArkProviderCtorMock).toHaveBeenCalledWith(
            "https://ark.example"
        );
        expect(runTasksMock).toHaveBeenCalledTimes(1);
        expect(runTasksMock).toHaveBeenCalledWith(
            taskQueue,
            expect.any(Array),
            expect.objectContaining({
                walletRepository,
                contractRepository,
                indexerProvider: expect.any(Object),
                arkProvider: expect.any(Object),
                extendVtxo: expect.any(Function),
            })
        );

        expect(taskQueue.acknowledgeResults).toHaveBeenCalledWith(["result-1"]);
        expect(taskQueue.getTasks).toHaveBeenCalledWith(
            CONTRACT_POLL_TASK_TYPE
        );
        expect(taskQueue.addTask).toHaveBeenCalledTimes(1);
        expect(taskQueue.addTask).toHaveBeenCalledWith(
            expect.objectContaining({
                type: CONTRACT_POLL_TASK_TYPE,
                data: {},
                createdAt: expect.any(Number),
            })
        );

        expect(result).toBe(1);
    });

    it("returns Success without running tasks when config is missing", async () => {
        const taskQueue = {
            loadConfig: vi.fn().mockResolvedValue(null),
        };
        const walletRepository = { id: "wallet-repository" };
        const contractRepository = { id: "contract-repository" };

        const { defineExpoBackgroundTask } = await loadBackground();

        defineExpoBackgroundTask("ark-no-config-task", {
            taskQueue: taskQueue as any,
            walletRepository: walletRepository as any,
            contractRepository: contractRepository as any,
        });

        const executor = defineTaskMock.mock.calls[0][1];
        const result = await executor();

        expect(result).toBe(1); // BackgroundTaskResult.Success
        expect(runTasksMock).not.toHaveBeenCalled();
    });

    it("returns Failed when the executor throws", async () => {
        const taskQueue = {
            loadConfig: vi.fn().mockResolvedValue({
                arkServerUrl: "https://ark.example",
                pubkeyHex: "01".repeat(32),
                serverPubKeyHex: "02".repeat(32),
                exitTimelockValue: "77",
                exitTimelockType: "blocks",
            }),
        };
        const walletRepository = { id: "wallet-repository" };
        const contractRepository = { id: "contract-repository" };
        runTasksMock.mockRejectedValue(new Error("network down"));

        const consoleSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        const { defineExpoBackgroundTask } = await loadBackground();

        defineExpoBackgroundTask("ark-failing-task", {
            taskQueue: taskQueue as any,
            walletRepository: walletRepository as any,
            contractRepository: contractRepository as any,
        });

        const executor = defineTaskMock.mock.calls[0][1];
        const result = await executor();

        expect(result).toBe(2); // BackgroundTaskResult.Failed
        expect(consoleSpy).toHaveBeenCalledWith(
            "[ark-sdk] Background task failed:",
            "network down"
        );

        consoleSpy.mockRestore();
    });

    it("registers and unregisters Expo background tasks", async () => {
        const { registerExpoBackgroundTask, unregisterExpoBackgroundTask } =
            await loadBackground();

        await registerExpoBackgroundTask("ark-background-task", {
            minimumInterval: 17,
        });
        await unregisterExpoBackgroundTask("ark-background-task");

        expect(registerTaskAsyncMock).toHaveBeenCalledWith(
            "ark-background-task",
            {
                minimumInterval: 17 * 60,
            }
        );
        expect(unregisterTaskAsyncMock).toHaveBeenCalledWith(
            "ark-background-task"
        );
    });
});
