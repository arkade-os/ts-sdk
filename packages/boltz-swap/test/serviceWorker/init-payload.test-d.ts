import { describe, it, expectTypeOf } from "vitest";
import type { RequestInitArkSwaps } from "../../src/serviceWorker/arkade-swaps-message-handler";
import type { SvcWrkArkadeSwapsConfig } from "../../src/serviceWorker/arkade-swaps-runtime";
import type { SerializableSwapManagerConfig } from "../../src/types";

/**
 * The init payload crosses a `postMessage` boundary, so structured clone must be
 * able to carry every field: no live provider objects, no functions.
 *
 * A `structuredClone` round-trip test would only catch fields the test happened
 * to populate — it cannot notice a provider field that a future commit adds to
 * `ArkadeSwapsConfig` and forgets to add to the payload's `Omit` list. These
 * assertions do, because they are about the type rather than an instance.
 *
 * These only bite under Vitest's typecheck mode — see tsconfig.typecheck.json.
 */

type Payload = RequestInitArkSwaps["payload"];

describe("RequestInitArkSwaps payload is structured-cloneable", () => {
    it("omits every live provider", () => {
        // Providers hold SSE/EventSource connections and cannot be cloned; the
        // worker rebuilds the ark and indexer ones from `arkServerUrl`.
        expectTypeOf<Payload>().not.toHaveProperty("arkProvider");
        expectTypeOf<Payload>().not.toHaveProperty("indexerProvider");
        expectTypeOf<Payload>().not.toHaveProperty("onchainProvider");
    });

    it("omits the wallet and the repository", () => {
        expectTypeOf<Payload>().not.toHaveProperty("wallet");
        expectTypeOf<Payload>().not.toHaveProperty("swapRepository");
    });

    it("carries swapManager only in its serializable projection", () => {
        // The full config type would admit `events`, a bag of callbacks that
        // structured clone rejects outright with a DataCloneError.
        expectTypeOf<Payload["swapManager"]>().toEqualTypeOf<
            SerializableSwapManagerConfig | undefined
        >();
        expectTypeOf<Exclude<Payload["swapManager"], boolean | undefined>>().not.toHaveProperty(
            "events",
        );
    });

    it("reduces swapProvider to a plain URL holder", () => {
        expectTypeOf<Payload["swapProvider"]>().toEqualTypeOf<{ baseUrl: string }>();
    });
});

describe("SvcWrkArkadeSwapsConfig steers callers away from events", () => {
    it("accepts a swap-manager config without events", () => {
        expectTypeOf<{ pollInterval: number; autoStart: boolean }>().toMatchTypeOf<
            NonNullable<SvcWrkArkadeSwapsConfig["swapManager"]>
        >();
    });

    it("rejects an events literal at the client call site", () => {
        // This is the check that actually fires for callers: an excess-property
        // check against an object literal. Width subtyping lets a pre-typed
        // config through, which is why create() also strips at runtime.
        expectTypeOf<
            Exclude<SvcWrkArkadeSwapsConfig["swapManager"], boolean | undefined>
        >().not.toHaveProperty("events");
    });
});
