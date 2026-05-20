/**
 * Expo background task entrypoint — `@arkade-os/boltz-swap/expo/background`.
 *
 * This subpath is the **only** module in the package that touches
 * `expo-task-manager` / `expo-background-task`. It is split out from
 * `/expo` on purpose: those packages have no web platform and are not
 * declared dependencies, so importing them from `/expo` would regress
 * react-native-web / Node consumers who only need the foreground APIs.
 *
 * The imports are static (not lazy `require()`) because Metro's static
 * dependency collector cannot see modules hidden behind `__require()` in
 * the ESM build — without static imports the packages never enter the
 * bundle graph and resolution fails at runtime. See
 * https://github.com/arkade-os/boltz-swap/issues/136 for details.
 *
 * Consumers install the peers in their Expo app:
 *   npx expo install expo-task-manager expo-background-task
 */
import * as TaskManager from "expo-task-manager";
import * as BackgroundTask from "expo-background-task";

import type { TaskItem } from "@arkade-os/sdk/worker/expo";
import { runTasks } from "@arkade-os/sdk/worker/expo";
import { ExpoArkProvider, ExpoIndexerProvider } from "@arkade-os/sdk/adapters/expo";
import { getRandomId, type IWallet } from "@arkade-os/sdk";
import { BoltzSwapProvider } from "../boltz-swap-provider";
import { swapsPollProcessor, SWAP_POLL_TASK_TYPE } from "./swapsPollProcessor";
import type {
    DefineSwapBackgroundTaskOptions,
    PersistedSwapBackgroundConfig,
    SwapTaskDependencies,
} from "./types";

export { swapsPollProcessor, SWAP_POLL_TASK_TYPE };
export type {
    DefineSwapBackgroundTaskOptions,
    PersistedSwapBackgroundConfig,
    SwapTaskDependencies,
};

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
            `[boltz-swap] Background wallet shim: "${String(method)}" is not implemented`,
        );
    };

    return {
        identity: args.identity,
        getAddress: args.getAddress,
        getBoardingAddress: async () => notImplemented("getBoardingAddress"),
        getBalance: async () => notImplemented("getBalance"),
        getVtxos: async () => notImplemented("getVtxos"),
        getBoardingUtxos: async () => notImplemented("getBoardingUtxos"),
        getTransactionHistory: async () => notImplemented("getTransactionHistory"),
        getContractManager: async () => notImplemented("getContractManager"),
        getDelegatorManager: async () => notImplemented("getDelegatorManager"),
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
 * **Must be called at module/global scope** (before React mounts) so
 * Expo's TaskManager can resume the task on cold start.
 *
 * Pair with {@link registerExpoSwapBackgroundTask} to activate the OS
 * scheduler — `ExpoArkadeSwaps.setup()` no longer registers the task
 * for you.
 *
 * @example
 * ```ts
 * // App entry (e.g. _layout.tsx) — module scope
 * import { defineExpoSwapBackgroundTask } from "@arkade-os/boltz-swap/expo/background";
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
    options: DefineSwapBackgroundTaskOptions,
): void {
    const { taskQueue, swapRepository, identityFactory } = options;

    TaskManager.defineTask(taskName, async () => {
        try {
            const config = await taskQueue.loadConfig<PersistedSwapBackgroundConfig>();
            if (!config) {
                // No config persisted yet — ExpoArkadeSwaps.setup() hasn't run.
                return BackgroundTask.BackgroundTaskResult.Success;
            }

            const identity = await identityFactory();

            const arkProvider = new ExpoArkProvider(config.arkServerUrl);
            const indexerProvider = new ExpoIndexerProvider(config.arkServerUrl);
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
                        serverPubKey.length === 33 ? serverPubKey.slice(1) : serverPubKey;
                    const hrp = info.network === "bitcoin" ? "ark" : "tark";
                    return new ArkAddress(xOnlyServerPubKey, pubkey, hrp).encode();
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
                await taskQueue.acknowledgeResults(results.map((r: { id: string }) => r.id));
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
                error instanceof Error ? error.message : error,
            );
            return BackgroundTask.BackgroundTaskResult.Failed;
        }
    });
}

/**
 * Activate the OS-level background task scheduler.
 *
 * Call once after {@link defineExpoSwapBackgroundTask} — typically right
 * after `ExpoArkadeSwaps.setup()`. Safe to call again to update the
 * interval.
 *
 * @param taskName - The task name passed to {@link defineExpoSwapBackgroundTask}.
 * @param options.minimumInterval - Minimum interval in **minutes** (default
 *   15, the floor enforced by `expo-background-task`).
 *
 * @see https://docs.expo.dev/versions/latest/sdk/background-task/#backgroundtaskoptions
 */
export async function registerExpoSwapBackgroundTask(
    taskName: string,
    options?: { minimumInterval?: number },
): Promise<void> {
    await BackgroundTask.registerTaskAsync(taskName, {
        minimumInterval: options?.minimumInterval ?? 15,
    });
}

/**
 * Unregister the swap background task from the OS scheduler.
 *
 * `ExpoArkadeSwaps.dispose()` does **not** call this — the OS-level
 * task lifecycle is the consumer's responsibility, matching the explicit
 * `register` step.
 */
export async function unregisterExpoSwapBackgroundTask(taskName: string): Promise<void> {
    await BackgroundTask.unregisterTaskAsync(taskName);
}
