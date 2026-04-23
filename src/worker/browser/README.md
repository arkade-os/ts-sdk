# Browser Service Worker

Background processing in the browser uses a `MessageBus` orchestrator running
inside a service worker, with pluggable `MessageHandler`s for business logic.
The bus handles lifecycle wiring, tag-based message routing, and a periodic tick
scheduler.

## Files and Responsibilities

- `messageBus.ts` (parent directory)
  - Defines `MessageHandler`, `RequestEnvelope`, `ResponseEnvelope`, and the
    `MessageBus` orchestrator.
  - Registers `install`/`activate` hooks, message routing (by `tag`), and a tick
    scheduler.
  - Manages lazy initialization: handlers are not started until the client sends
    an `INITIALIZE_MESSAGE_BUS` message with wallet/server configuration.
  - Provides static helpers `MessageBus.setup()` and
    `MessageBus.getServiceWorker()` for client-side registration.
- `service-worker-manager.ts`
  - Browser-side helper for registering a service worker once per path.
  - Attaches an update handshake: detect `waiting`, send `SKIP_WAITING`, listen for
    `controllerchange`, and optionally reload (or call callbacks).
  - Caches registration promises so subsequent calls reuse the same worker.
  - Provides `setupServiceWorkerOnce()` and `getActiveServiceWorker()`.
- `utils.ts`
  - A simpler, one-off `setupServiceWorker()` helper that registers and waits
    for activation with a timeout.

## Runtime Flow

1. The page registers the service worker (via `MessageBus.setup()` or the
   helpers in this directory).
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
import {
    serializeSigningIdentity,
    serializeReadonlyIdentity,
    SingleKey,
    MnemonicIdentity,
} from "@arkade-os/sdk";

const sw = await MessageBus.setup("/service-worker.js");

// Initialize the message bus with a tagged SerializedIdentity envelope.
// Build one from any SDK-owned identity using the helpers:
//   - serializeSigningIdentity(identity) for a wallet that signs.
//   - serializeReadonlyIdentity(identity) for a watch-only wallet (always
//     downgrades to readonly even if passed a signing identity).
const identity = MnemonicIdentity.fromMnemonic("abandon abandon ...");
const wallet = serializeSigningIdentity(identity);

sw.postMessage({
    type: "INITIALIZE_MESSAGE_BUS",
    id: "init-1",
    tag: "INITIALIZE_MESSAGE_BUS",
    config: {
        wallet,
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

### `SerializedIdentity` wire shape

The `config.wallet` field carries a tagged `SerializedIdentity` envelope so
that the worker can rehydrate the matching identity class:

| Tag                    | Shape                                                             | Hydrates as                   |
| ---------------------- | ----------------------------------------------------------------- | ----------------------------- |
| `single-key`           | `{ type: "single-key", privateKey }`                              | `SingleKey`                   |
| `seed`                 | `{ type: "seed", seed, descriptor }`                              | `SeedIdentity`                |
| `mnemonic`             | `{ type: "mnemonic", mnemonic, descriptor, passphrase? }`         | `MnemonicIdentity`            |
| `readonly-single-key`  | `{ type: "readonly-single-key", publicKey }`                      | `ReadonlySingleKey`           |
| `readonly-descriptor`  | `{ type: "readonly-descriptor", descriptor }`                     | `ReadonlyDescriptorIdentity`  |

All payloads are structured-clone safe. Signing envelopes ship the secret
material needed for signing; readonly envelopes never do. The helpers
`serializeSigningIdentity` / `serializeReadonlyIdentity` select the right
variant for any SDK-owned identity class.

### Wire-format compatibility

For reverse compatibility with workers that predate `SerializedIdentity`,
the SDK's `ServiceWorkerWallet` / `ServiceWorkerReadonlyWallet` factories
still emit the historic untagged `{ privateKey }` / `{ publicKey }` shapes
on the wire for `SingleKey` / `ReadonlySingleKey` identities (via
`toWireSerializedIdentity`). The other variants (`seed`, `mnemonic`,
`readonly-descriptor`) are always emitted in their tagged form; they never
had a legacy shape, so older workers cannot handle them regardless.

| Identity class                | Wire shape (current)                        | Works on old worker? |
| ----------------------------- | ------------------------------------------- | -------------------- |
| `SingleKey`                   | `{ privateKey }` (legacy)                   | yes                  |
| `ReadonlySingleKey`           | `{ publicKey }` (legacy)                    | yes                  |
| `SeedIdentity`                | `{ type: "seed", ... }`                     | no — new variant     |
| `MnemonicIdentity`            | `{ type: "mnemonic", ... }`                 | no — new variant     |
| `ReadonlyDescriptorIdentity`  | `{ type: "readonly-descriptor", ... }`      | no — new variant     |

Workers accept both tagged and legacy shapes through
`normalizeSerializedIdentity`; a one-time `[ts-sdk]` deprecation warning
is logged when a legacy shape is seen. Both the legacy wire emission and
the legacy-shape adapter are slated for removal in the next major.

## Registering with the built-in update handshake

`setupServiceWorkerOnce` now handles stale workers by:
- forcing an update check,
- sending `{ type: "SKIP_WAITING" }` to a waiting worker,
- retrying once after a timeout if it’s still waiting,
- reloading the page on `controllerchange` (or invoking callbacks).

Quick usage (defaults to auto-reload and `updateViaCache: "none"`):

```ts
await setupServiceWorkerOnce("/service-worker.js");
```

With prompts/callbacks:

```ts
await setupServiceWorkerOnce({
  path: "/service-worker.js",
  autoReload: false,          // don't reload automatically
  onNeedRefresh: () => showUpdateBanner(), // called when a new SW is waiting
  onUpdated: () => console.log("SW activated; reload if desired"),
  activationTimeoutMs: 10_000,
  debug: true,
});
```

Worker requirement: your service worker entry must listen for the activation
message and call `skipWaiting()`:

```ts
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
```
