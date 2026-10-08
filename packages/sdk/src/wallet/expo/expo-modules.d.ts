/**
 * Ambient declarations for soft-optional Expo peer dependencies.
 *
 * These modules are declared as optional peers and are not installed at
 * build time. This file lets `tsc` type-check the subset of their APIs
 * the SDK actually imports, without pulling the packages into devDeps.
 *
 * Covers:
 *   - expo-task-manager      (src/wallet/expo/background.ts)
 *   - expo-background-task   (src/wallet/expo/background.ts)
 *
 * Consumers install these in their own Expo app:
 *   npx expo install expo-task-manager expo-background-task
 */

declare module "expo-task-manager" {
    export function defineTask(
        taskName: string,
        executor: (body: {
            data: unknown;
            error: { code: string | number; message: string } | null;
            executionInfo: { eventId: string; taskName: string };
        }) => Promise<unknown>,
    ): void;
}

declare module "expo-background-task" {
    export const BackgroundTaskResult: { Success: 1; Failed: 2 };
    export function registerTaskAsync(
        taskName: string,
        options?: { minimumInterval?: number },
    ): Promise<void>;
    export function unregisterTaskAsync(taskName: string): Promise<void>;
}
