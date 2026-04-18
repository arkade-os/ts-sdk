/**
 * Expo/React Native entrypoint for `@arkade-os/boltz-swap`.
 *
 * Provides an {@link ExpoArkadeSwaps} wrapper plus helpers to register
 * an Expo background task for best-effort swap polling and claim/refund.
 */
export { ExpoArkadeSwaps, ExpoArkadeLightning } from "./arkade-lightning";
export {
    defineExpoSwapBackgroundTask,
    registerExpoSwapBackgroundTask,
    unregisterExpoSwapBackgroundTask,
} from "./background";
export { swapsPollProcessor, SWAP_POLL_TASK_TYPE } from "./swapsPollProcessor";
export type {
    SwapTaskDependencies,
    PersistedSwapBackgroundConfig,
    ExpoSwapBackgroundConfig,
    DefineSwapBackgroundTaskOptions,
    ExpoArkadeSwapsConfig,
    ExpoArkadeLightningConfig,
} from "./types";
