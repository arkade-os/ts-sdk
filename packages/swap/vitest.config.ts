import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../config/vitest.base";

export default mergeConfig(
    base,
    defineConfig({
        test: {
            // `ContractWatcher` subscribes over SSE, and Node exposes
            // `EventSource` only behind this flag (24.x). Without it every
            // subscription fails with "EventSource is not defined", the manager
            // emits no `vtxo_received`/`vtxo_spent`, and anything event-driven
            // — `watchOfferSwaps`, `RfqSwapManager`'s contract subscription —
            // silently degrades to whatever polling the test does itself.
            poolOptions: { forks: { execArgv: ["--experimental-eventsource"] } },
        },
    }),
);
