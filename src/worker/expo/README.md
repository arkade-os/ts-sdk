# Expo Background Tasks (Service-Centric)

Expo/React Native cannot run a long-lived service worker. Background work is executed by the OS every ~15 minutes for a short window, and foreground/background never overlap. The SDK therefore keeps all orchestration inside a single service and uses a lightweight task queue (AsyncStorage-backed in production, in-memory for tests) to hand off work/results across wakes.

## Usage (matches browser wallet API)

The wallet surface stays the same; extra Expo wiring is injected only at `setup`. No public `registerTask` or `tick` methods are exposed.

```ts
import { ExpoWallet } from "@arkade-os/sdk/wallet/expo";
import { InMemoryTaskQueue, contractPollProcessor } from "@arkade-os/sdk/worker/expo";
import { SingleKey } from "@arkade-os/sdk";
// Prefer an AsyncStorage-backed TaskQueue in production.

const wallet = await ExpoWallet.setup({
    identity: SingleKey.fromHex(privateKey),
    arkServerUrl,
    esploraUrl,
    storage: { walletRepository, contractRepository },
    background: {
        taskName: "ark-background-poll",        // used by expo-background-task
        taskQueue: new InMemoryTaskQueue(),     // plug in AsyncStorage queue later
        processors: [contractPollProcessor],    // defaults to [contractPollProcessor]
        foregroundIntervalMs: 20_000,           // optional: auto-poll while app is active
    },
});

// After setup, use the wallet like the browser version:
const balance = await wallet.getBalance();
```

## Architecture

### Components

| Module | Path | Role |
|--------|------|------|
| **TaskQueue** | `src/worker/expo/taskQueue.ts` | Inbox/outbox persistence interface + `InMemoryTaskQueue` |
| **TaskRunner** | `src/worker/expo/taskRunner.ts` | `TaskProcessor` interface + `runTasks()` orchestration |
| **Processors** | `src/worker/expo/processors/` | Stateless units that handle one task type each |
| **ExpoWallet** | `src/wallet/expo/wallet.ts` | Wraps `Wallet`, delegates `IWallet`, manages polling |

### How it works

- **Foreground polling** (if `foregroundIntervalMs` is set): a `setInterval` runs `runTasks()` on each tick, immediately consumes results, and re-seeds the queue for the next cycle.
- **Background wake** (TODO: wire to `expo-background-task`): Expo calls into the service with `taskName`; the service rehydrates config/providers, runs the injected `processors` over tasks in the queue, and writes results to the outbox.
- **Foreground resume** (TODO): the service reads the outbox, acknowledges results, and re-seeds the queue.

### Data flow

```
Foreground (app active):
  ExpoWallet.setup() seeds a contract-poll task in the inbox
  → setInterval calls runForegroundPoll()
  → runTasks() dispatches to ContractPollProcessor
  → Processor fetches VTXOs from indexer, saves to repository
  → Results acknowledged immediately, task re-seeded

Background (15+ min later, TODO):
  Expo BackgroundTask wakes up
  → Loads persisted queue
  → Runs runTasks() with processors
  → Results pushed to outbox
  → Returns BackgroundTaskResult.Success

App returns to foreground (TODO):
  ExpoWallet reads outbox from TaskQueue
  → Acknowledges results, re-seeds task
```

### Comparison with Service Worker approach

The browser SDK uses `MessageBus` inside a service worker with `MessageHandler`s and tick-based scheduling. Expo cannot use this because:

1. No `ServiceWorkerGlobalScope` (`self`, `clients.matchAll()`, etc.)
2. Background tasks are short-lived (no persistent event loop)
3. Foreground and background never run simultaneously

The Expo approach replaces `MessageBus` with direct `runTasks()` calls and `MessageHandler` with `TaskProcessor`. The `TaskQueue` inbox/outbox replaces `postMessage` for cross-context communication.
