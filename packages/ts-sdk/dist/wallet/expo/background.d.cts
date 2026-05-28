import { W as WalletRepository, C as ContractRepository } from '../../ark-loKbOrJY.cjs';
import { a as AsyncStorageTaskQueue } from '../../asyncStorageTaskQueue-h0dkmXEv.cjs';
import { T as TaskProcessor } from '../../taskRunner--xNlod--.cjs';
import '@scure/btc-signer/transaction.js';
import '@scure/btc-signer/utils.js';
import '@scure/btc-signer/psbt.js';
import '@scure/btc-signer';

/**
 * Wallet parameters persisted by @see ExpoWallet.setup and read
 * by the background handler to reconstruct providers and `extendVtxo`
 * without a network call.
 */
interface PersistedBackgroundConfig {
    arkServerUrl: string;
    pubkeyHex: string;
    serverPubKeyHex: string;
    exitTimelockValue: string;
    exitTimelockType: "blocks" | "seconds";
}
/**
 * Options for @see defineExpoBackgroundTask.
 */
interface DefineBackgroundTaskOptions {
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
declare function defineExpoBackgroundTask(taskName: string, options: DefineBackgroundTaskOptions): void;
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
declare function registerExpoBackgroundTask(taskName: string, options?: {
    minimumInterval?: number;
}): Promise<void>;
/**
 * Unregister the background task from the OS scheduler.
 *
 * `ExpoWallet.dispose()` does **not** call this — the OS-level task
 * lifecycle is the consumer's responsibility, matching the explicit
 * `register` step.
 */
declare function unregisterExpoBackgroundTask(taskName: string): Promise<void>;

export { type DefineBackgroundTaskOptions, type PersistedBackgroundConfig, defineExpoBackgroundTask, registerExpoBackgroundTask, unregisterExpoBackgroundTask };
