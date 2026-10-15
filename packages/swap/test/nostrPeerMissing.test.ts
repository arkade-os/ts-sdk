import { describe, expect, it, vi } from "vitest";
import { discoverMarkets } from "../src/markets";
import { InMemoryAssetSwapRepository } from "../src/repository";
import { pointedSolver } from "./client/fixtures";

// the optional peer is not installed, so the default card fetcher cannot load
vi.mock("../src/nostr", () => {
    throw new Error("Cannot find package 'nostr-tools'");
});

const REGISTRY = "https://registry.example/regtest.json";

describe("without the nostr-tools peer", () => {
    it("lets the registry's answer replace the cache: no card could ever arrive", async () => {
        const pointed = pointedSolver();
        const repository = new InMemoryAssetSwapRepository();
        const fetchImpl = (async () =>
            new Response(JSON.stringify(pointed.index))) as unknown as typeof fetch;
        await discoverMarkets({
            network: "regtest",
            registryUrl: REGISTRY,
            repository,
            fetchImpl,
            transportCards: { fetch: async () => [pointed.card()] },
        });
        expect(
            await discoverMarkets({
                network: "regtest",
                registryUrl: REGISTRY,
                repository,
                fetchImpl,
                useCache: false,
            }),
        ).toEqual([]);
        expect((await repository.getCachedMarkets("regtest", REGISTRY))?.markets).toEqual([]);
    });
});
