import type { TaskItem } from "@arkade-os/sdk/worker/expo";
import { runTasks } from "@arkade-os/sdk/worker/expo";
import {
    ExpoArkProvider,
    ExpoIndexerProvider,
} from "@arkade-os/sdk/adapters/expo";
import type { IWallet } from "@arkade-os/sdk";
import { BoltzSwapProvider } from "../boltz-swap-provider";
import { swapsPollProcessor, SWAP_POLL_TASK_TYPE } from "./swapsPollProcessor";
import type {
    DefineSwapBackgroundTaskOptions,
    PersistedSwapBackgroundConfig,
    SwapTaskDependencies,
} from "./types";

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

function getRandomId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Minimal IWallet for Expo background tasks (~30s window).
 * Only `identity` and `getAddress` are used — for signing claim/refund
 * transactions and deriving the Ark address respectively.
 * Everything else throws so accidental usage is caught immediately.
 */
function createBackgroundWalletShim(args: {
    identity: IWallet["identity"];
    getAddress: IWallet["getAddress"];
}): IWallet {
    const notImplemented = (method: keyof IWallet): never => {
        throw new Error(
            `[boltz-swap] Background wallet shim: "${String(method)}" is not implemented`
        );
    };

    return {
        identity: args.identity,
        getAddress: args.getAddress,
        getBoardingAddress: async () => notImplemented("getBoardingAddress"),
        getBalance: async () => notImplemented("getBalance"),
        getVtxos: async () => notImplemented("getVtxos"),
        getBoardingUtxos: async () => notImplemented("getBoardingUtxos"),
        getTransactionHistory: async () =>
            notImplemented("getTransactionHistory"),
        getContractManager: async () => notImplemented("getContractManager"),
        sendBitcoin: async () => notImplemented("sendBitcoin"),
        send: async () => notImplemented("send"),
        settle: async () => notImplemented("settle"),
        assetManager: new Proxy({} as IWallet["assetManager"], {
            get: () => notImplemented("assetManager" as keyof IWallet),
        }),
    };
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Define the Expo background task handler for swap polling.
 *
 * **Must be called at module/global scope** (before React mounts).
 * Internally calls `TaskManager.defineTask()`.
 *
 * @example
 * ```ts
 * // At the top of your app entry file (_layout.tsx)
 * import { defineExpoSwapBackgroundTask } from "@arkade-os/boltz-swap/expo";
 * import { AsyncStorageTaskQueue } from "@arkade-os/sdk/worker/expo";
 * import AsyncStorage from "@react-native-async-storage/async-storage";
 *
 * const taskQueue = new AsyncStorageTaskQueue(AsyncStorage, "ark:swap-queue");
 * defineExpoSwapBackgroundTask("ark-swap-poll", {
 *     taskQueue,
 *     swapRepository,
 *     identityFactory: async () => {
 *         const key = await SecureStore.getItemAsync("ark-private-key");
 *         return SingleKey.fromHex(key!);
 *     },
 * });
 * ```
 */
export function defineExpoSwapBackgroundTask(
    taskName: string,
    options: DefineSwapBackgroundTaskOptions
): void {
    const TaskManager = requireTaskManager();
    const BackgroundTask = requireBackgroundTask();

    const { taskQueue, swapRepository, identityFactory } = options;

    TaskManager.defineTask(taskName, async () => {
        try {
            const config =
                await taskQueue.loadConfig<PersistedSwapBackgroundConfig>();
            if (!config) {
                // No config persisted yet — ExpoArkadeSwaps.setup() hasn't run.
                return BackgroundTask.BackgroundTaskResult.Success;
            }

            // Reconstruct Identity from secure storage
            const identity = await identityFactory();

            // Reconstruct providers
            const arkProvider = new ExpoArkProvider(config.arkServerUrl);
            const indexerProvider = new ExpoIndexerProvider(
                config.arkServerUrl
            );
            const swapProvider = new BoltzSwapProvider({
                network: config.network,
                apiUrl: config.boltzApiUrl,
            });

            const wallet = createBackgroundWalletShim({
                identity,
                getAddress: async () => {
                    const { ArkAddress } = await import("@arkade-os/sdk");
                    const { hex } = await import("@scure/base");
                    const info = await arkProvider.getInfo();
                    const pubkey = await identity.xOnlyPublicKey();
                    const serverPubKey = hex.decode(info.signerPubkey);
                    const xOnlyServerPubKey =
                        serverPubKey.length === 33
                            ? serverPubKey.slice(1)
                            : serverPubKey;
                    const hrp = info.network === "bitcoin" ? "ark" : "tark";
                    return new ArkAddress(
                        xOnlyServerPubKey,
                        pubkey,
                        hrp
                    ).encode();
                },
            });

            const deps: SwapTaskDependencies = {
                swapRepository,
                swapProvider,
                arkProvider,
                indexerProvider,
                identity,
                wallet,
            };

            await runTasks(taskQueue, [swapsPollProcessor], deps);

            // Acknowledge outbox results (no foreground to consume them)
            const results = await taskQueue.getResults();
            if (results.length > 0) {
                await taskQueue.acknowledgeResults(
                    results.map((r: { id: string }) => r.id)
                );
            }

            // Re-seed the swap-poll task for the next OS wake
            const existing = await taskQueue.getTasks(SWAP_POLL_TASK_TYPE);
            if (existing.length === 0) {
                const task: TaskItem = {
                    id: getRandomId(),
                    type: SWAP_POLL_TASK_TYPE,
                    data: {},
                    createdAt: Date.now(),
                };
                await taskQueue.addTask(task);
            }

            return BackgroundTask.BackgroundTaskResult.Success;
        } catch (error) {
            console.error(
                "[boltz-swap] Background task failed:",
                error instanceof Error ? error.message : error
            );
            return BackgroundTask.BackgroundTaskResult.Failed;
        }
    });
}

/**
 * Activate the OS-level background task scheduler.
 *
 * Call this after {@link defineExpoSwapBackgroundTask} (typically inside
 * {@link ExpoArkadeSwaps.setup}).
 *
 * @param taskName - The task name registered with defineExpoSwapBackgroundTask.
 * @param options - Optional configuration.
 * @param options.minimumInterval - Minimum interval in minutes (default 15).
 */
export async function registerExpoSwapBackgroundTask(
    taskName: string,
    options?: { minimumInterval?: number }
): Promise<void> {
    const BackgroundTask = requireBackgroundTask();
    await BackgroundTask.registerTaskAsync(taskName, {
        // expo-background-task expects minutes:
        // https://docs.expo.dev/versions/latest/sdk/background-task/#backgroundtaskoptions
        minimumInterval: options?.minimumInterval ?? 15,
    });
}

/**
 * Unregister the swap background task from the OS scheduler.
 */
export async function unregisterExpoSwapBackgroundTask(
    taskName: string
): Promise<void> {
    const BackgroundTask = requireBackgroundTask();
    await BackgroundTask.unregisterTaskAsync(taskName);
}
