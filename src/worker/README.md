# Worker Architecture

This folder contains a message-driven Service Worker framework built around the
`MessageBus` orchestrator and pluggable `MessageHandler`s. The message bus handles
lifecycle wiring, message routing, and a periodic tick scheduler. Business logic
lives in message handlers.

## Files and Responsibilities

- `messageBus.ts`
  - Defines `MessageHandler`, `RequestEnvelope`, `ResponseEnvelope`, and the
    `MessageBus` orchestrator.
  - Registers `install`/`activate` hooks, message routing (by `tag`), and a tick
    scheduler.
  - Manages lazy initialization: handlers are not started until the client sends
    an `INITIALIZE_MESSAGE_BUS` message with wallet/server configuration.
  - Provides static helpers `MessageBus.setup()` and
    `MessageBus.getServiceWorker()` for client-side registration.
- `browser/service-worker-manager.ts`
  - Browser-side helper for registering a service worker once per path.
  - Caches registration promises so subsequent calls reuse the same worker.
  - Provides `setupServiceWorkerOnce()` and `getActiveServiceWorker()`.
- `browser/utils.ts`
  - A simpler, one-off `setupServiceWorker()` helper that registers and waits
    for activation with a timeout.

## Runtime Flow

1. The page registers the service worker (via `MessageBus.setup()` or the
   helpers in `browser/`).
2. Inside the service worker, create a `MessageBus` with message handlers and
   call `start()`. This hooks `install` (calls `skipWaiting()`) and `activate`
   (calls `clients.claim()`).
3. The client sends an `INITIALIZE_MESSAGE_BUS` message with wallet and Ark
   server configuration. The `MessageBus` builds services (wallet, provider)
   and calls `start()` on each handler, then begins the tick loop.
4. Subsequent client messages are routed by `tag` (the handler's `messageTag`)
   or broadcast to all handlers.
5. Handlers can respond immediately (via `handleMessage`) or later (via `tick`).
   Responses are posted back to clients.

## MessageHandler Interface

Each handler implements the `MessageHandler` interface:

- `messageTag` — unique string used to route messages to this handler.
- `start(services, repositories)` — called once after initialization with the
  wallet, Ark provider, and repositories.
- `stop()` — called on shutdown.
- `tick(now)` — called periodically; returns responses to broadcast to clients.
- `handleMessage(message)` — handles a routed message and returns a response.

## Trade-Offs

- **Polling-based updates**: The tick loop uses `setTimeout`. Updates arrive at
  most every `tickIntervalMs` (default 10s).
- **No persistence**: Handler state is in-memory. If the browser kills the
  service worker, state is lost unless the handler persists it elsewhere.
- **Minimal lifecycle hooks**: Only `install` and `activate` are used. There is
  no `fetch`, `sync`, or `push` integration.
- **Broadcast granularity**: Broadcast responses are sent to all window clients.
  There is no per-client filtering or backpressure management.

## Quick Example

Below is a minimal handler that echoes messages and emits a periodic heartbeat.

```ts
// Inside your service worker entry script
import { MessageBus, MessageHandler, RequestEnvelope, ResponseEnvelope } from "./worker/messageBus";

type EchoRequest = RequestEnvelope & { payload?: string };
type EchoResponse = ResponseEnvelope & { payload?: string };

class EchoHandler implements MessageHandler<EchoRequest, EchoResponse> {
    readonly messageTag = "echo";

    async start() {
        // Initialize state, open DB connections, etc.
    }

    async stop() {
        // Clean up resources.
    }

    async tick(_now: number): Promise<EchoResponse[]> {
        return [
            {
                tag: this.messageTag,
                id: "heartbeat",
                broadcast: true,
                payload: "tick",
            },
        ];
    }

    async handleMessage(message: EchoRequest): Promise<EchoResponse | null> {
        return {
            tag: this.messageTag,
            id: message.id,
            payload: message.payload ?? "",
        };
    }
}

const bus = new MessageBus(walletRepository, contractRepository, {
    messageHandlers: [new EchoHandler()],
    tickIntervalMs: 10_000,
    debug: true,
});

bus.start();
```

On the client side:

```ts
const sw = await MessageBus.setup("/service-worker.js");

// Initialize the message bus with wallet config
sw.postMessage({
    type: "INITIALIZE_MESSAGE_BUS",
    id: "init-1",
    tag: "INITIALIZE_MESSAGE_BUS",
    config: {
        wallet: { privateKey: "..." },
        arkServer: { url: "https://..." },
    },
});

// Send a message to the echo handler
sw.postMessage({ tag: "echo", id: "req-1", payload: "hello" });
```

Notes:
- Each handler must provide a unique `messageTag`.
- The `id` field correlates responses to requests.
- Set `broadcast: true` on a request to fan it out to all handlers.
- The `MessageBus` must receive `INITIALIZE_MESSAGE_BUS` before handlers process
  messages; earlier messages are dropped with a warning.

## Planned: Platform-Agnostic Background Processing

The `MessageHandler` interface and envelope types (`RequestEnvelope`,
`ResponseEnvelope`) are already platform-agnostic — they are pure TypeScript
types with no Service Worker runtime dependency. The `MessageBus` class,
however, is tied to the SW global (`self`, `clients.matchAll`, etc.).

The next step is to support platforms where service workers are not available,
starting with Expo/React Native. The approach reuses the same handler pattern
while swapping the orchestrator and communication layer.

### Expo Background Tasks — Inbox/Outbox Model

Expo background tasks have different constraints than service workers:

- **Short-lived**: the OS wakes the app every ~15 minutes for a brief window.
- **No concurrent foreground/background**: the two never run simultaneously.
- **No message API**: communication happens through shared persistence only.

The planned design introduces two new abstractions:

- **`TaskQueue`** — a persistence layer (inbox + outbox) backed by AsyncStorage
  (or InMemory for tests). The foreground writes tasks to the inbox; the
  background reads them, executes, and writes results to the outbox; the
  foreground reads results on resume.
- **`TaskProcessor`** — a stateless unit that knows how to execute one type of
  task (e.g. `contract-poll`, `vtxo-renewal`). Receives dependencies
  (providers, repositories) at call time.

Two components sit on top of these:

| Component | Role |
|---|---|
| `TaskQueueHandler` | Implements `MessageHandler`. On `tick()`, reads the inbox, delegates to the appropriate `TaskProcessor`, persists results to the outbox, and returns broadcast responses. |
| `ExpoBackgroundService` | Client-facing proxy. Manages the Expo BackgroundTask lifecycle, builds providers from persisted config on wake-up, runs the handler, and dispatches outbox results to callbacks when the app returns to the foreground. |

### Data Flow

```
Foreground (app active)
  Consumer → service.registerTask() → TaskQueueHandler → inbox

App suspended
  Expo BackgroundTask wakes up
  → loads persisted config
  → builds providers
  → handler.tick() processes inbox → outbox
  → BackgroundTaskResult.Success

App resumes
  Service reads outbox → dispatches to callbacks → acknowledges results
```

### Foreground Tick Loop

While the app is active, a lightweight in-process bus (`ExpoMessageBus`)
replicates the core routing and tick logic of `MessageBus` without any SW
dependencies. It accepts the same `MessageHandler[]`, keeping handler code
identical across platforms.

### What Does Not Change

- The existing `MessageBus` class and browser service worker path are untouched.
- `ContractManager`, `VtxoManager`, and other managers are unaware of the task
  queue — they remain consumers of repositories and providers as before.
