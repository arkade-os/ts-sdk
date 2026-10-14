# Worker

Platform-specific background processing for the SDK. Both implementations share a common pattern (pluggable handlers, periodic scheduling, repository/provider injection) but differ in orchestration and communication, because the browser and Expo/React Native runtimes constrain background work differently.

| Platform              | Directory                         | Orchestrator                                                           | Communication                               |
| --------------------- | --------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| **Browser**           | [`browser/`](./browser/README.md) | `MessageBus` inside a Service Worker                                   | `postMessage` between SW and window clients |
| **Expo/React Native** | [`expo/`](./expo/README.md)       | `runTasks()` driven by a foreground interval and an OS background wake | `AsyncStorageTaskQueue` inbox/outbox        |

See the platform READMEs for architecture details, runtime flow, and usage examples. `messageBus.ts` in this directory defines the shared `MessageBus` / `MessageHandler` primitives that the browser worker uses directly and that the Expo wallet wraps in its own service.
