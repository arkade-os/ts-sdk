/**
 * Ambient declarations for `expo-task-manager` and `expo-background-task`.
 *
 * Why this file exists: these modules are required at runtime by
 * `src/expo/background.ts` but are intentionally **not** declared in this
 * package's `dependencies` / `peerDependencies` — they are soft-optional
 * and only needed by Expo Android/iOS consumers (no web platform exists).
 * This file lets `tsc` type-check the subset of their APIs we actually
 * use, without pulling the packages into our build.
 *
 * Consumers install them in their own Expo app:
 *   npx expo install expo-task-manager expo-background-task
 */

declare module "expo-task-manager" {
    export function defineTask(
        taskName: string,
        executor: (body: {
            data: unknown;
            error: { code: string | number; message: string } | null;
            executionInfo: { eventId: string; taskName: string };
        }) => Promise<unknown>
    ): void;
}

declare module "expo-background-task" {
    export const BackgroundTaskResult: { Success: 1; Failed: 2 };
    export function registerTaskAsync(
        taskName: string,
        options?: { minimumInterval?: number }
    ): Promise<void>;
    export function unregisterTaskAsync(taskName: string): Promise<void>;
}
