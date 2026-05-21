/**
 * Expo/React Native entrypoint for `@arkade-os/boltz-swap`.
 *
 * Foreground-only APIs. For background-task helpers, import from
 * `@arkade-os/boltz-swap/expo/background` — that subpath is split out
 * so non-Expo consumers (react-native-web, Node) don't pull
 * `expo-task-manager` / `expo-background-task` into their bundle graph.
 *
 * ```ts
 * import { ExpoArkadeSwaps } from "@arkade-os/boltz-swap/expo";
 * import { defineExpoSwapBackgroundTask } from "@arkade-os/boltz-swap/expo/background";
 * ```
 */
export { ExpoArkadeSwaps, ExpoArkadeLightning } from "./arkade-lightning";
export { SWAP_POLL_TASK_TYPE } from "./swapsPollProcessor";
export type {
    SwapTaskDependencies,
    PersistedSwapBackgroundConfig,
    ExpoSwapBackgroundConfig,
    DefineSwapBackgroundTaskOptions,
    ExpoArkadeSwapsConfig,
    ExpoArkadeLightningConfig,
} from "./types";
