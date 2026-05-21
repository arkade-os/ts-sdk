/**
 * Expo/React Native entrypoint for `@arkade-os/sdk/wallet/expo`.
 *
 * Foreground-only APIs. For the background-task helpers, import from
 * `@arkade-os/sdk/wallet/expo/background` — that subpath is split out
 * so non-Expo consumers (react-native-web, Node) don't pull
 * `expo-task-manager` / `expo-background-task` into their bundle
 * graph. See https://github.com/arkade-os/ts-sdk/issues/486.
 *
 * ```ts
 * import { ExpoWallet } from "@arkade-os/sdk/wallet/expo";
 * import { defineExpoBackgroundTask } from "@arkade-os/sdk/wallet/expo/background";
 * ```
 */
export { ExpoWallet } from "./wallet";
export type { ExpoWalletConfig, ExpoBackgroundConfig } from "./wallet";
