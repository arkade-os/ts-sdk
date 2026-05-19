# Expo Background Tasks (Service-Centric)

Expo/React Native cannot run a long-lived service worker. Background work is executed by the OS every ~15 minutes for a short window, and foreground/background never overlap. The SDK therefore keeps all orchestration inside a single service and uses a lightweight task queue (AsyncStorage-backed in production, in-memory for tests) to hand off work/results across wakes.

> [!WARNING]
> **Change since 0.4.27** — fix for [#486](https://github.com/arkade-os/ts-sdk/issues/486).
>
> Background-task helpers moved from `@arkade-os/sdk/wallet/expo` to
> `@arkade-os/sdk/wallet/expo/background`. OS-level registration is no
> longer performed by `ExpoWallet.setup()` — call
> `registerExpoBackgroundTask` explicitly. The split keeps the
> `expo-task-manager` / `expo-background-task` imports out of
> `/wallet/expo`, so they stay invisible to Metro's static dependency
> collector only on the subpath that needs them.
>
> | Before                                                                                 | After                                                                                                                          |
> | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
> | `import { defineExpoBackgroundTask } from "@arkade-os/sdk/wallet/expo"`                | `import { defineExpoBackgroundTask } from "@arkade-os/sdk/wallet/expo/background"`                                             |
> | `background: { taskName, taskQueue, foregroundIntervalMs, minimumBackgroundInterval }` | `background: { taskQueue, foregroundIntervalMs }` + explicit `await registerExpoBackgroundTask(taskName, { minimumInterval })` |
> | `dispose()` unregistered the OS task                                                   | Call `unregisterExpoBackgroundTask(taskName)` yourself                                                                         |
>
> TypeScript callers get a compile error on the removed fields. **JS callers must update manually** — the old fields are silently ignored and the OS task will never run.

## Usage

### 1. Define the background task (global scope)

`TaskManager.defineTask()` must be called at module scope before React mounts. The SDK provides `defineExpoBackgroundTask` to handle this.

```ts
// App entry point (e.g., _layout.tsx or index.ts) — GLOBAL SCOPE
import "@/polyfills/indexeddb";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { defineExpoBackgroundTask } from "@arkade-os/sdk/wallet/expo/background";
import { AsyncStorageTaskQueue } from "@arkade-os/sdk/worker/expo";
import { IndexedDBWalletRepository, IndexedDBContractRepository } from "@arkade-os/sdk";

const taskQueue = new AsyncStorageTaskQueue(AsyncStorage);

defineExpoBackgroundTask("ark-background-poll", {
    taskQueue,
    walletRepository: new IndexedDBWalletRepository(),
    contractRepository: new IndexedDBContractRepository(),
});
```

### 2. Set up the wallet (in a React component/provider)

The wallet surface matches the browser version. `ExpoWallet.setup()` persists config for background rehydration; the OS scheduler is activated separately with `registerExpoBackgroundTask`.

```ts
import { ExpoWallet } from "@arkade-os/sdk/wallet/expo";
import { registerExpoBackgroundTask } from "@arkade-os/sdk/wallet/expo/background";
import { SingleKey } from "@arkade-os/sdk";

const wallet = await ExpoWallet.setup({
    identity: SingleKey.fromHex(privateKey),
    arkServerUrl,
    esploraUrl,
    storage: { walletRepository, contractRepository },
    background: {
        taskQueue, // same instance from step 1
        foregroundIntervalMs: 20_000, // poll every 20s while app is active
    },
});

// Activate the OS scheduler (Expo Android/iOS only).
// Must use the same task name passed to defineExpoBackgroundTask above.
await registerExpoBackgroundTask("ark-background-poll", { minimumInterval: 15 });

// Use like a regular wallet:
const balance = await wallet.getBalance();

// On logout / wallet reset / app teardown:
import { unregisterExpoBackgroundTask } from "@arkade-os/sdk/wallet/expo/background";
await wallet.dispose();
await unregisterExpoBackgroundTask("ark-background-poll");
```

> [!IMPORTANT]
> The OS-task helpers (`defineExpoBackgroundTask`,
> `registerExpoBackgroundTask`, `unregisterExpoBackgroundTask`) live
> under `@arkade-os/sdk/wallet/expo/background`. That subpath is the
> **only** module that imports `expo-task-manager` /
> `expo-background-task`; keeping it isolated lets react-native-web and
> Node consumers use `/wallet/expo` without those native packages.

## Architecture

### Components

| Module                    | Path                                       | Role                                                   |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| **TaskQueue**             | `src/worker/expo/taskQueue.ts`             | Inbox/outbox interface + `InMemoryTaskQueue`           |
| **AsyncStorageTaskQueue** | `src/worker/expo/asyncStorageTaskQueue.ts` | Persistent queue backed by AsyncStorage                |
| **TaskRunner**            | `src/worker/expo/taskRunner.ts`            | `TaskProcessor` interface + `runTasks()` orchestration |
| **Processors**            | `src/worker/expo/processors/`              | Stateless units that handle one task type each         |
| **ExpoWallet**            | `src/wallet/expo/wallet.ts`                | Wraps `Wallet`, delegates `IWallet`, manages polling   |
| **Background bridge**     | `src/wallet/expo/background.ts`            | `defineExpoBackgroundTask`, OS scheduler registration  |

### Data flow

```
Setup (one-time):
  defineExpoBackgroundTask() registers the handler at global scope
  ExpoWallet.setup() persists wallet config to AsyncStorageTaskQueue
  ExpoWallet.setup() seeds a contract-poll task in the inbox
  registerExpoBackgroundTask() activates the OS scheduler (caller invokes)

Foreground (app active):
  setInterval calls runForegroundPoll()
  → runTasks() dispatches to ContractPollProcessor
  → Processor fetches VTXOs from indexer, saves to repository
  → Results acknowledged immediately, task re-seeded

Background (15+ min later):
  OS wakes the app, calls the handler from defineExpoBackgroundTask()
  → Handler reads persisted config from AsyncStorageTaskQueue
  → Reconstructs providers + extendVtxo (no network call needed)
  → Runs runTasks() with processors
  → Results pushed to outbox
  → Returns BackgroundTaskResult.Success

Foreground resume:
  Next foreground poll tick runs runTasks()
  → Processes any tasks, acknowledges background outbox results
  → Re-seeds the task for the next cycle
```

### Background rehydration

The background handler runs in a fresh JS context with no shared memory. `ExpoWallet.setup()` persists a lightweight config blob (`PersistedBackgroundConfig`) containing:

- `arkServerUrl` — to create `ExpoIndexerProvider` / `ExpoArkProvider`
- `pubkeyHex`, `serverPubKeyHex`, `exitTimelock` — to reconstruct `DefaultVtxo.Script` and `extendVtxo`

This avoids an `arkProvider.getInfo()` network call during the short background window.

### Comparison with Service Worker approach

The browser SDK uses `MessageBus` inside a service worker with `MessageHandler`s and tick-based scheduling. Expo cannot use this because:

1. No `ServiceWorkerGlobalScope` (`self`, `clients.matchAll()`, etc.)
2. Background tasks are short-lived (no persistent event loop)
3. Foreground and background never run simultaneously

The Expo approach replaces `MessageBus` with direct `runTasks()` calls and `MessageHandler` with `TaskProcessor`. The `AsyncStorageTaskQueue` inbox/outbox replaces `postMessage` for cross-context communication.
