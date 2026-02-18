import { hex } from "@scure/base";
import type { WalletRepository } from "../../repositories/walletRepository";
import type { ContractRepository } from "../../repositories/contractRepository";
import type { AsyncStorageTaskQueue } from "../../worker/expo/asyncStorageTaskQueue";
import type { TaskProcessor } from "../../worker/expo/taskRunner";
import type { TaskItem } from "../../worker/expo/taskQueue";
import { runTasks } from "../../worker/expo/taskRunner";
import {
    contractPollProcessor,
    CONTRACT_POLL_TASK_TYPE,
} from "../../worker/expo/processors";
import { DefaultVtxo } from "../../script/default";
import { DelegateVtxo } from "../../script/delegate";
import { ExpoArkProvider } from "../../providers/expoArk";
import { ExpoIndexerProvider } from "../../providers/expoIndexer";
import { extendVirtualCoin, getRandomId } from "../utils";

// ── Inline type declarations for optional Expo packages ──────────
// These avoid a hard build-time dependency on expo-background-task
// and expo-task-manager (they are optional peerDependencies).

interface TaskManagerModule {
    defineTask(
        taskName: string,
        executor: (body: {
            data: unknown;
            error: { code: string | number; message: string } | null;
            executionInfo: { eventId: string; taskName: string };
        }) => Promise<unknown>
    ): void;
}

interface BackgroundTaskModule {
    BackgroundTaskResult: { Success: 1; Failed: 2 };
    registerTaskAsync(
        taskName: string,
        options?: { minimumInterval?: number }
    ): Promise<void>;
    unregisterTaskAsync(taskName: string): Promise<void>;
}

function requireTaskManager(): TaskManagerModule {
    try {
        return require("expo-task-manager") as TaskManagerModule;
    } catch {
        throw new Error(
            "expo-task-manager is required for background tasks. " +
                "Install it with: npx expo install expo-task-manager"
        );
    }
}

function requireBackgroundTask(): BackgroundTaskModule {
    try {
        return require("expo-background-task") as BackgroundTaskModule;
    } catch {
        throw new Error(
            "expo-background-task is required for background tasks. " +
                "Install it with: npx expo install expo-background-task"
        );
    }
}

// ── Persisted config ─────────────────────────────────────────────

/**
 * Wallet parameters persisted by {@link ExpoWallet.setup} and read
 * by the background handler to reconstruct providers and `extendVtxo`
 * without a network call.
 */
export interface PersistedBackgroundConfig {
    arkServerUrl: string;
    pubkeyHex: string;
    serverPubKeyHex: string;
    exitTimelockValue: string;
    exitTimelockType: "blocks" | "seconds";
    /** Optional delegate public key (hex). Present when wallet uses delegate mode. */
    delegatePubKeyHex?: string;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Options for {@link defineExpoBackgroundTask}.
 */
export interface DefineBackgroundTaskOptions {
    /** AsyncStorage-backed queue (must match the one passed to ExpoWallet.setup). */
    taskQueue: AsyncStorageTaskQueue;
    /** Wallet repository (fresh instance is fine — connects to the same DB). */
    walletRepository: WalletRepository;
    /** Contract repository (fresh instance is fine — connects to the same DB). */
    contractRepository: ContractRepository;
    /** Processors to run. Defaults to `[contractPollProcessor]`. */
    processors?: TaskProcessor[];
}

/**
 * Define the Expo background task handler.
 *
 * **Must be called at module/global scope** (before React mounts).
 * Internally calls `TaskManager.defineTask()`.
 *
 * @example
 * ```ts
 * // At the top of your app entry file
 * import { defineExpoBackgroundTask } from "@arkade-os/sdk/wallet/expo";
 * import { AsyncStorageTaskQueue } from "@arkade-os/sdk/worker/expo";
 * import AsyncStorage from "@react-native-async-storage/async-storage";
 *
 * const taskQueue = new AsyncStorageTaskQueue(AsyncStorage);
 * defineExpoBackgroundTask("ark-background-poll", {
 *     taskQueue,
 *     walletRepository: new IndexedDBWalletRepository(),
 *     contractRepository: new IndexedDBContractRepository(),
 * });
 * ```
 */
export function defineExpoBackgroundTask(
    taskName: string,
    options: DefineBackgroundTaskOptions
): void {
    const TaskManager = requireTaskManager();
    const BackgroundTask = requireBackgroundTask();

    const {
        taskQueue,
        walletRepository,
        contractRepository,
        processors = [contractPollProcessor],
    } = options;

    TaskManager.defineTask(taskName, async () => {
        try {
            const config =
                await taskQueue.loadConfig<PersistedBackgroundConfig>();
            if (!config) {
                // No config persisted yet — ExpoWallet.setup() hasn't run.
                // Nothing to do.
                return BackgroundTask.BackgroundTaskResult.Success;
            }

            // Reconstruct providers
            const indexerProvider = new ExpoIndexerProvider(
                config.arkServerUrl
            );
            const arkProvider = new ExpoArkProvider(config.arkServerUrl);

            // Reconstruct offchainTapscript for extendVtxo
            const pubKey = hex.decode(config.pubkeyHex);
            const serverPubKey = hex.decode(config.serverPubKeyHex);
            const csvTimelock = {
                value: BigInt(config.exitTimelockValue),
                type: config.exitTimelockType as "blocks" | "seconds",
            };
            const offchainTapscript = config.delegatePubKeyHex
                ? new DelegateVtxo.Script({
                      pubKey,
                      serverPubKey,
                      delegatePubKey: hex.decode(config.delegatePubKeyHex),
                      csvTimelock,
                  })
                : new DefaultVtxo.Script({
                      pubKey,
                      serverPubKey,
                      csvTimelock,
                  });

            await runTasks(taskQueue, processors, {
                walletRepository,
                contractRepository,
                indexerProvider,
                arkProvider,
                extendVtxo: (vtxo) =>
                    extendVirtualCoin({ offchainTapscript }, vtxo),
            });

            // Acknowledge outbox results (no foreground to consume them)
            const results = await taskQueue.getResults();
            if (results.length > 0) {
                await taskQueue.acknowledgeResults(results.map((r) => r.id));
            }

            // Re-seed the contract-poll task for the next OS wake
            const existing = await taskQueue.getTasks(CONTRACT_POLL_TASK_TYPE);
            if (existing.length === 0) {
                const task: TaskItem = {
                    id: getRandomId(),
                    type: CONTRACT_POLL_TASK_TYPE,
                    data: {},
                    createdAt: Date.now(),
                };
                await taskQueue.addTask(task);
            }

            return BackgroundTask.BackgroundTaskResult.Success;
        } catch (error) {
            console.error(
                "[ark-sdk] Background task failed:",
                error instanceof Error ? error.message : error
            );
            return BackgroundTask.BackgroundTaskResult.Failed;
        }
    });
}

/**
 * Activate the OS-level background task scheduler.
 *
 * Call this after {@link defineExpoBackgroundTask} (typically inside
 * {@link ExpoWallet.setup} or in a React component after wallet init).
 *
 * @param minimumInterval - Minimum interval in minutes (default 15).
 */
export async function registerExpoBackgroundTask(
    taskName: string,
    options?: { minimumInterval?: number }
): Promise<void> {
    const BackgroundTask = requireBackgroundTask();
    await BackgroundTask.registerTaskAsync(taskName, {
        minimumInterval: (options?.minimumInterval ?? 15) * 60,
    });
}

/**
 * Unregister the background task from the OS scheduler.
 */
export async function unregisterExpoBackgroundTask(
    taskName: string
): Promise<void> {
    const BackgroundTask = requireBackgroundTask();
    await BackgroundTask.unregisterTaskAsync(taskName);
}
