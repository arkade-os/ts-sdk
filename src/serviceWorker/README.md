# Service Worker Architecture

This folder contains a small, message-driven Service Worker framework with a
pluggable "updater" model. It is intentionally minimal: the service worker is
only responsible for lifecycle wiring, message routing, and a periodic scheduler.
Business logic lives in updaters.

## Files and Responsibilities

- `worker.ts`
  - Defines `IUpdater` and the `Worker` orchestrator.
  - Registers `install`/`activate` hooks, message routing, and a tick scheduler.
  - Runs each updater on `start()` and `tick()`, and forwards responses to clients.
- `service-worker-manager.ts`
  - Browser-side helper for registering a service worker once per path.
  - Provides `getActiveServiceWorker()` for a ready instance.
- `utils.ts`
  - A simpler, one-off `setupServiceWorker()` helper that registers and waits
    for activation.

## Runtime Flow

1. The page registers the service worker (via `service-worker-manager.ts` or
   `utils.ts`).
2. The service worker calls `Worker.start()`, which:
   - Starts each updater with `start()`.
   - Hooks `install` (calls `skipWaiting()`) and `activate` (calls `clients.claim()`).
   - Starts the periodic tick loop.
3. Clients post messages to the service worker. `Worker` routes them by `targetTag`
   (the updater's `messageTag`) or broadcasts to all updaters.
4. Updaters can respond immediately (via `handleRequest`) or later (via `tick`).
   Responses are posted back to clients. Updaters can also emit requests from
   `tick` to other updaters (see Cross-Updater Requests below).

## Trade-Offs of the Current Solution

- **Polling-based updates**: The tick loop uses `setTimeout`. This is simple but
  not push-based; updates arrive at most every `tickIntervalMs` (default 30s).
- **No persistence**: Updater state is in-memory. If the browser kills the
  service worker, state is lost unless the updater persists it elsewhere.
- **Minimal lifecycle hooks**: Only `install` and `activate` are used. There is
  no `fetch`, `sync`, or `push` integration.
- **Broadcast granularity**: Broadcast responses are sent to all window clients.
  There is no per-client filtering or backpressure management.
- **Simple error handling**: Errors are logged and a stringified error response
  is posted. There is no retry or structured error schema.

These trade-offs keep the worker small and predictable but may limit
responsiveness or robustness for more complex scenarios.

## Quick Example: Creating Your Own Updater

Below is a minimal updater that echoes messages and emits a periodic heartbeat.
It can be registered inside your service worker entry script.

```ts
// src/service-worker.ts
import { Worker, IUpdater, RequestEnvelope, ResponseEnvelope } from "./serviceWorker/worker";

type EchoRequest = RequestEnvelope & { payload?: string };
type EchoResponse = ResponseEnvelope & { payload?: string };

class EchoUpdater implements IUpdater<EchoRequest, EchoResponse> {
    readonly messageTag = "echo";

    async start() {
        // Initialize state, open DB connections, etc.
    }

    async stop() {
        // Clean up resources.
    }

    async tick(): Promise<Array<EchoResponse | RequestEnvelope>> {
        return [
            {
                sourceTag: this.messageTag,
                id: "heartbeat",
                broadcast: true,
                payload: "tick",
            },
        ];
    }

    async handleRequest(message: EchoRequest): Promise<EchoResponse | null> {
        return {
            sourceTag: this.messageTag,
            id: message.id,
            payload: message.payload ?? "",
        };
    }
}

const worker = new Worker({
    updaters: [new EchoUpdater()],
    tickIntervalMs: 10_000,
    debug: true,
});

worker.start();
```

On the client, you can post a message with the updater's `messageTag`:

```ts
// Client-side
const sw = await Worker.getServiceWorker("/service-worker.js");
sw.postMessage({ targetTag: "echo", id: "req-1", payload: "hello" });
```

Notes:
- Each updater must provide a unique `messageTag`.
- The `id` is used to correlate responses to requests.
- If you set `broadcast: true`, the `Worker` will forward the message or response
  to all window clients.

## Cross-Updater Requests (New)

Updaters can now emit **requests** from `tick()` and route them to another updater.
To do this, return a `RequestEnvelope` from `tick()` with a `targetTag`. The target
updater handles it via `handleRequest`. If the request includes a `sourceTag`, the
response will be routed back to that origin updater via `handleResponse` (if implemented).
If `broadcast: true` is set on the response, it will also be sent to clients.

Example:

```ts
// Updater A tick() emits a request to Updater B
return [
  {
    targetTag: "updater-b",
    sourceTag: "updater-a",
    id: "req-42",
    payload: { ... },
  },
];
```


## Cross-platform support

The goal is to support multiple JS runtimes from day zero, even if some targets are “best-effort”. The architecture should not require changes as new runtimes are added.

Proposed API:

```javascript
import { Worker } from "@arkade-os/sdk";
import { IndexedDBSwapRepository } from "@arkade-os/boltz-swap";
import { IndexedDBWalletRepository } from "./walletRepository";
import { IndexedDBContractRepository } from "./contractRepository";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";

const walletUpdater = new WalletUpdater(
    new IndexedDBWalletRepository(),
    new IndexedDBContractRepository()
);
const boltzSwapUpdater = new BoltzSwapUpdater(new IndexedDBSwapRepository());

// Rename ServiceWorkerWallet to WalletRuntime to remove platform-specific naming.
const browserSvc = WalletRuntime.setupServiceWorker({
    // current WalletRuntime.setupServiceWorker()
    serviceWorkerPath: "wallet-service-worker.mjs",
    identity: SingleKey.fromHex(privateKey),
    arkServerUrl,
    esploraUrl,
    storage: { walletRepository, contractRepository },
});
const nodeSvc = WalletRuntime.setupNodeWorker({
    updaters: [walletUpdater, boltzSwapUpdater],
    identity: SingleKey.fromHex(privateKey),
    arkServerUrl,
    esploraUrl,
});
const expoSvc = WalletRuntime.setupExpoWorker(
    {
        updaters: [walletUpdater, boltzSwapUpdater],
        identity: SingleKey.fromHex(privateKey),
        arkServerUrl,
        esploraUrl,
        minimumInterval: 15, // minimum interval for tasks to run
        taskName: "ark-wallet-runtime-task",
    },
    {
        BackgroundTask,
        TaskManager,
    }
);
```

The static methods on `Worker` encapsulate the runtime-specific logic:
- `setupServiceWorker`: get or create the SW, initialize it. Work runs on the SW side; the main thread uses a message-based thin interface.
- `setupNodeWorker`: run in the main thread, with optional offload to [Node Worker Threads](https://nodejs.org/api/worker_threads.html#worker-threads). Suggested option: `taskExecutionMode: "inline" | "worker"` (default: `inline`).
- `setupExpoWorker`: run in the main thread and register [background tasks](https://docs.expo.dev/versions/latest/sdk/background-task/). Background completion is best-effort.

Given `src/wallet/serviceWorker/wallet.ts` and `src/wallet/serviceWorker/wallet-updater.ts` as the baseline:
- functionality is exposed via the `WalletRuntime` interface (e.g. `WalletRuntime.settle()`).
- the SW implementation uses `postMessage`.
- the Node and Expo implementations call `IUpdater.{handleRequest|handleResponse|tick()}` directly.

Tasks are modeled as a response type _Task_ (name subject to change) which is a function that returns `REQ|RES|Task` and is handled differently:
- SW runs it in-place.
- Node runs it in-place by default (or in a Worker thread if `taskExecutionMode` is `worker`).
- Expo registers a task *and* runs it in place. If the local execution succeeds, the registered task is cancelled. On foreground, the runtime checks registered tasks and runs them, cancelling as they complete. This yields immediate execution on a best-effort basis and eventual completion when possible.
- Note: React Native (bare/ejected) is not directly compatible with Expo TaskManager APIs. A separate scheduler adapter will be required (e.g. `react-native-background-fetch` on Android and background fetch on iOS).
- Expo details: `TaskManager.defineTask` must be called in the global scope (not inside React lifecycle methods). Expo Background Task uses a single worker; the last registered task determines the minimum interval. `BackgroundTask.getStatusAsync()` can be used to detect availability (web returns `Restricted`).

### Task persistence (proposal)

Tasks are not persisted as code. Persist a minimal `TaskRecord` so the runtime can re-evaluate:

```ts
type TaskRecord = {
  id: string;            // runtime-generated unique id
  name: string;          // task name, e.g. "TASK_SETTLE"
  sourceTag: string;     // updater that owns the task
  createdAt: number;     // timestamp
  metadata: any;         // JSON payload, e.g. { vtxos: [1,2,3] }
};
```

The runtime **evicts** persisted tasks first, then calls `reviewTasks()` on the owning updater. The updater can inspect storage and decide what to do next:

```ts
reviewTasks?(tasks: TaskRecord[]): Promise<Array<Request | Response | Task>>;
```

If the updater wants to retry, it can return the same task again (or a new one). This will be treated as a new task and re-persisted by the runtime if needed.

### Trade-offs
- [PRO] it's simple for the consumer, only defines the `svc` and its `IUpdater` and the runtime will be managed for you
- [CONS] it's complex for us to implement and possibly maintain

### Why are we doing this?

**Allow async activities like swaps and settlements to complete**
