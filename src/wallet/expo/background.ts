/**
 * Expo background task entrypoint — `@arkade-os/sdk/wallet/expo/background`.
 *
 * This subpath is the **only** module in the package that touches
 * `expo-task-manager` / `expo-background-task`. It is split out from
 * `/wallet/expo` on purpose: those packages have no web platform and
 * are declared as optional peer dependencies, so importing them from
 * `/wallet/expo` would regress react-native-web / Node consumers who
 * only need the foreground APIs.
 *
 * The imports are static (not lazy `require()`) because Metro's static
 * dependency collector cannot see modules hidden behind `__require()`
 * in the ESM build — without static imports the packages never enter
 * the bundle graph and resolution fails at runtime. See
 * https://github.com/arkade-os/ts-sdk/issues/486 for details.
 *
 * Consumers install the peers in their Expo app:
 *   npx expo install expo-task-manager expo-background-task
 */
import * as TaskManager from "expo-task-manager";
import * as BackgroundTask from "expo-background-task";

import type { WalletRepository } from "../../repositories/walletRepository";
import type { ContractRepository } from "../../repositories/contractRepository";
import type { AsyncStorageTaskQueue } from "../../worker/expo/asyncStorageTaskQueue";
import type { TaskProcessor } from "../../worker/expo/taskRunner";
import type { TaskItem } from "../../worker/expo/taskQueue";
import { runTasks, createTaskDependencies } from "../../worker/expo/taskRunner";
import {
    contractPollProcessor,
    CONTRACT_POLL_TASK_TYPE,
} from "../../worker/expo/processors";
import { ExpoArkProvider } from "../../providers/expoArk";
import { ExpoIndexerProvider } from "../../providers/expoIndexer";
import { getRandomId } from "../utils";

// ── Persisted config ─────────────────────────────────────────────

/**
 * Wallet parameters persisted by @see ExpoWallet.setup and read
 * by the background handler to reconstruct providers and `extendVtxo`
 * without a network call.
 */
export interface PersistedBackgroundConfig {
    arkServerUrl: string;
    pubkeyHex: string;
    serverPubKeyHex: string;
    exitTimelockValue: string;
    exitTimelockType: "blocks" | "seconds";
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Options for @see defineExpoBackgroundTask.
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
 * **Must be called at module/global scope** (before React mounts) so
 * Expo's TaskManager can resume the task on cold start.
 *
 * Pair with @see registerExpoBackgroundTask to activate the OS
 * scheduler — `ExpoWallet.setup()` no longer registers the task for
 * you.
 *
 * @example
 * ```ts
 * // App entry (e.g. _layout.tsx) — module scope
 * import { defineExpoBackgroundTask } from "@arkade-os/sdk/wallet/expo/background";
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

            const indexerProvider = new ExpoIndexerProvider(
                config.arkServerUrl
            );
            const arkProvider = new ExpoArkProvider(config.arkServerUrl);

            const deps = createTaskDependencies({
                walletRepository,
                contractRepository,
                indexerProvider,
                arkProvider,
            });

            await runTasks(taskQueue, processors, deps);

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
 * Call once after @see defineExpoBackgroundTask — typically right after
 * `ExpoWallet.setup()`. Safe to call again to update the interval.
 *
 * @param taskName - The task name passed to {@link defineExpoBackgroundTask}.
 * @param options.minimumInterval - Minimum interval in **minutes** (default
 *   15, the floor enforced by `expo-background-task`).
 *
 * @see https://docs.expo.dev/versions/latest/sdk/background-task/#backgroundtaskoptions
 */
export async function registerExpoBackgroundTask(
    taskName: string,
    options?: { minimumInterval?: number }
): Promise<void> {
    await BackgroundTask.registerTaskAsync(taskName, {
        minimumInterval: (options?.minimumInterval ?? 15) * 60,
    });
}

/**
 * Unregister the background task from the OS scheduler.
 *
 * `ExpoWallet.dispose()` does **not** call this — the OS-level task
 * lifecycle is the consumer's responsibility, matching the explicit
 * `register` step.
 */
export async function unregisterExpoBackgroundTask(
    taskName: string
): Promise<void> {
    await BackgroundTask.unregisterTaskAsync(taskName);
}
