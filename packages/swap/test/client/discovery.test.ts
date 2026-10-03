/**
 * The three states one market array used to collapse, separated.
 *
 * The distinction that matters most is the last one: a registry that answered
 * with nothing is authoritative, and a registry that did not answer is not. v1
 * returns `[]` for both, plus for a network with no index and for no registry at
 * all, and a caller cannot tell which of the four it got.
 */
import { describe, expect, it, vi } from "vitest";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import { discoveryIndex, isUsableCard } from "../../src/client/discovery";
import { DiscoverySnapshotUnavailable } from "../../src/client/errors";
import { InMemoryAssetSwapRepository } from "../../src/repository";
import { indexOf, lightningCard, spotCard } from "./fixtures";

const REGISTRY = "https://registry.example/regtest.json";

const serving = (markets: DiscoveredMarket[]) =>
    vi.fn(async () => new Response(JSON.stringify(indexOf(markets)))) as unknown as typeof fetch &
        ReturnType<typeof vi.fn>;

const failing = () =>
    vi.fn(async () => {
        throw new Error("registry unreachable");
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe("with nothing to resolve against", () => {
    it("refuses to resolve when the registry is deliberately disabled", async () => {
        const fetchImpl = serving([]);
        const index = discoveryIndex({
            network: "regtest",
            config: { registryUrl: null, fetchImpl },
        });
        await expect(index.peek()).rejects.toThrow(DiscoverySnapshotUnavailable);
        await expect(index.load()).rejects.toThrow(/registry was disabled/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("asks the network's default registry when none is configured", async () => {
        const fetchImpl = serving([lightningCard]);
        const index = discoveryIndex({ network: "regtest", config: { fetchImpl } });
        const snapshot = await index.load();
        expect(snapshot.markets).toHaveLength(1);
        expect(snapshot.ref).toMatchObject({
            live: true,
            source: "live",
            registry: "https://arkade-os.github.io/solver-registry/regtest.json",
        });
        expect(fetchImpl).toHaveBeenCalledWith(
            "https://arkade-os.github.io/solver-registry/regtest.json",
        );
    });

    it("prefers an explicit registry over the network default", async () => {
        const fetchImpl = serving([lightningCard]);
        const index = discoveryIndex({
            network: "regtest",
            config: { registryUrl: REGISTRY, fetchImpl },
        });
        const snapshot = await index.load();
        expect(snapshot.ref).toMatchObject({ registry: REGISTRY });
        expect(fetchImpl).toHaveBeenCalledWith(REGISTRY);
    });

    it("names the network when no index is published for it", async () => {
        const index = discoveryIndex({
            network: "testnet",
            config: { registryUrl: REGISTRY, fetchImpl: serving([]) },
        });
        await expect(index.load()).rejects.toThrow(/no market index is published for testnet/);
    });

    it("refuses when the registry is unreachable and nothing is cached", async () => {
        const fetchImpl = failing();
        const index = discoveryIndex({
            network: "regtest",
            config: { registryUrl: REGISTRY, fetchImpl },
            repository: new InMemoryAssetSwapRepository(),
        });
        await expect(index.load()).rejects.toThrow(/could not be reached and nothing is cached/);
    });
});

describe("a reachable registry", () => {
    it("serves a live snapshot and writes the cache the v1 path reads", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const index = discoveryIndex({
            network: "regtest",
            config: { registryUrl: REGISTRY, fetchImpl: serving([lightningCard, spotCard]) },
            repository,
        });
        const snapshot = await index.load();

        expect(snapshot.markets).toHaveLength(2);
        expect(snapshot.ref).toMatchObject({ live: true, source: "live", registry: REGISTRY });
        expect((await repository.getCachedMarkets("regtest", REGISTRY))?.markets).toHaveLength(2);
    });

    it("is authoritative when it lists nothing — an empty snapshot, not an error", async () => {
        const index = discoveryIndex({
            network: "regtest",
            config: { registryUrl: REGISTRY, fetchImpl: serving([]) },
        });
        const snapshot = await index.load();
        expect(snapshot.markets).toEqual([]);
        expect(snapshot.ref.live).toBe(true);
    });

    it("holds the snapshot, and refetches only when asked", async () => {
        const fetchImpl = serving([lightningCard]);
        const index = discoveryIndex({
            network: "regtest",
            config: { registryUrl: REGISTRY, fetchImpl },
        });
        await index.load();
        await index.load();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        await index.load({ refresh: true });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});

describe("an unreachable registry with a cache behind it", () => {
    const cached = async () => {
        const repository = new InMemoryAssetSwapRepository();
        await repository.saveCachedMarkets("regtest", REGISTRY, {
            markets: [lightningCard],
            fetchedAt: Date.now() - 60_000,
        });
        return repository;
    };

    it("resolves, and says the snapshot is not live", async () => {
        const index = discoveryIndex({
            network: "regtest",
            config: { registryUrl: REGISTRY, fetchImpl: failing() },
            repository: await cached(),
        });
        const snapshot = await index.load();
        expect(snapshot.markets).toHaveLength(1);
        expect(snapshot.ref).toMatchObject({ live: false, source: "cache" });
    });

    it("is what `peek()` reads, without touching the network at all", async () => {
        const fetchImpl = failing();
        const index = discoveryIndex({
            network: "regtest",
            config: { registryUrl: REGISTRY, fetchImpl },
            repository: await cached(),
        });
        const snapshot = await index.peek();
        expect(snapshot.ref.source).toBe("cache");
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe("an injected snapshot", () => {
    it("resolves offline and counts as a source that can be trusted", async () => {
        const fetchImpl = failing();
        const index = discoveryIndex({
            network: "regtest",
            config: { snapshot: [lightningCard], fetchImpl },
        });
        expect((await index.peek()).ref).toMatchObject({ live: true, source: "injected" });
        expect((await index.load()).markets).toEqual([lightningCard]);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe("the cache as a trust boundary", () => {
    it("keeps a card whose every depended-on field survived the round trip", () => {
        expect(isUsableCard(lightningCard)).toBe(true);
        expect(isUsableCard(spotCard)).toBe(true);
    });

    it("keeps a canonical card with no deprecated display or corridor fields", () => {
        const canonical = {
            ...lightningCard,
            pair: undefined,
            base_corridor: undefined,
            quote_corridor: undefined,
            base_asset: {
                ...lightningCard.base_asset,
                id: "arkade:regtest/slip44:0",
            },
            quote_asset: {
                ...lightningCard.quote_asset,
                id: "bolt11:regtest/slip44:0",
            },
        };

        expect(isUsableCard(canonical)).toBe(true);
    });

    it("drops a corridor card with no rendezvous, which the v1 read trusts", () => {
        const { discovery_pubkey, ...noKey } = lightningCard;
        expect(isUsableCard(noKey)).toBe(false);
        expect(isUsableCard({ ...lightningCard, transports: { nostr: { relays: [] } } })).toBe(
            false,
        );
        expect(isUsableCard({ ...lightningCard, discovery_pubkey: "not-a-key" })).toBe(false);
    });

    it("drops a card whose corridor is not one this client knows", () => {
        expect(isUsableCard({ ...lightningCard, quote_corridor: "teleport" as never })).toBe(false);
    });

    it("drops the malformed card, one card at a time", async () => {
        const repository = new InMemoryAssetSwapRepository();
        await repository.saveCachedMarkets("regtest", REGISTRY, {
            markets: [spotCard, { ...lightningCard, transports: undefined }],
            fetchedAt: Date.now(),
        });
        const index = discoveryIndex({
            network: "regtest",
            config: { registryUrl: REGISTRY, fetchImpl: failing() },
            repository,
        });
        expect((await index.peek()).markets).toEqual([spotCard]);
    });
});
