/**
 * Market resolution: the key both sides of a negotiation derive independently,
 * the candidate set the policy filters run over, and the addressability check
 * that keeps an unreachable card out of it.
 */
import { describe, expect, it, vi } from "vitest";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import type { DiscoverySnapshot } from "../../src/client/discovery";
import {
    chooseMarket,
    eligibleMarkets,
    isAddressable,
    marketKeyOf,
    marketRefOf,
    type MarketCandidate,
} from "../../src/client/market";
import { arkadeAsset, btcOn } from "../../src/client/assetId";
import { toDiscoveryLeg } from "../../src/client/aliases";
import { asset } from "@arkade-os/sdk";
import { lightningCard, onchainCard, rivalLightningCard, spotCard, USD_ASSET_ID } from "./fixtures";

const snapshotOf = (markets: DiscoveredMarket[]): DiscoverySnapshot => ({
    markets,
    ref: { fetchedAt: 1_700_000_000_000, live: true, source: "injected" },
});

const ARKADE_BTC = {
    corridor: "arkade",
    assetId: "btc",
    marketId: "arkade:regtest/slip44:1",
} as const;
const LIGHTNING_BTC = {
    corridor: "lightning",
    assetId: "btc",
    marketId: "bolt11:regtest/slip44:1",
} as const;
const ONCHAIN_BTC = {
    corridor: "onchain",
    assetId: "btc",
    marketId: "bitcoin:regtest/slip44:1",
} as const;
const ARKADE_USD = {
    corridor: "arkade",
    assetId: USD_ASSET_ID,
    marketId: `arkade:regtest/asset:${USD_ASSET_ID}`,
} as const;

describe("the canonical market key", () => {
    it("puts the arkade leg first, whichever side the card publishes it on", () => {
        expect(marketKeyOf(lightningCard)).toBe("arkade:btc/lightning:btc");
        // The same market with its legs published the other way round derives
        // the same key — which is the whole point: both sides of a published
        // negotiation derive it independently and subscribe by it.
        const inverted: DiscoveredMarket = {
            ...lightningCard,
            base_corridor: "lightning",
            quote_corridor: "arkade",
        };
        expect(marketKeyOf(inverted)).toBe("arkade:btc/lightning:btc");
    });

    it("sorts the legs when both are arkade, or neither is", () => {
        expect(marketKeyOf(spotCard)).toBe(`arkade:btc/arkade:${USD_ASSET_ID}`);
        const crossCorridor: DiscoveredMarket = {
            ...lightningCard,
            base_corridor: "onchain",
            quote_corridor: "lightning",
        };
        expect(marketKeyOf(crossCorridor)).toBe("lightning:btc/onchain:btc");
    });
});

describe("the eligible set", () => {
    it("finds canonical CAIP-19 cards as well as legacy corridor cards", () => {
        const canonical: DiscoveredMarket = {
            ...lightningCard,
            base_asset: {
                ...lightningCard.base_asset,
                caip19_id: ARKADE_BTC.marketId,
            },
            quote_asset: {
                ...lightningCard.quote_asset,
                caip19_id: LIGHTNING_BTC.marketId,
            },
        };

        expect(
            eligibleMarkets(snapshotOf([canonical]), {
                give: ARKADE_BTC,
                take: LIGHTNING_BTC,
            }).map((candidate) => candidate.card),
        ).toEqual([canonical]);
        expect(
            eligibleMarkets(snapshotOf([lightningCard]), {
                give: ARKADE_BTC,
                take: LIGHTNING_BTC,
            }).map((candidate) => candidate.card),
        ).toEqual([lightningCard]);
    });

    it("finds one card in both directions", () => {
        const snapshot = snapshotOf([lightningCard, onchainCard, spotCard]);
        const send = eligibleMarkets(snapshot, { give: ARKADE_BTC, take: LIGHTNING_BTC });
        const receive = eligibleMarkets(snapshot, { give: LIGHTNING_BTC, take: ARKADE_BTC });

        expect(send.map((c) => c.card)).toEqual([lightningCard]);
        expect(send[0]).toMatchObject({ give: "base", backend: "rfq" });
        expect(receive.map((c) => c.card)).toEqual([lightningCard]);
        // Giving the quote side is the other orientation of the same card.
        expect(receive[0]).toMatchObject({ give: "quote", backend: "rfq" });
    });

    it("reads the backend off the card, never off the route", () => {
        const snapshot = snapshotOf([spotCard]);
        const [candidate] = eligibleMarkets(snapshot, { give: ARKADE_BTC, take: ARKADE_USD });
        expect(candidate).toMatchObject({ backend: "feed", give: "base" });
    });

    it("serves no market for a pair nobody lists", () => {
        const snapshot = snapshotOf([lightningCard]);
        expect(eligibleMarkets(snapshot, { give: ARKADE_BTC, take: ONCHAIN_BTC })).toEqual([]);
    });

    it("is empty for one leg twice, whatever the cards say", () => {
        const snapshot = snapshotOf([lightningCard, spotCard]);
        expect(eligibleMarkets(snapshot, { give: ARKADE_BTC, take: ARKADE_BTC })).toEqual([]);
    });

    it("drops a corridor card nothing can address", () => {
        const { discovery_pubkey, ...unreachable } = lightningCard;
        expect(isAddressable(unreachable)).toBe(false);
        expect(isAddressable(spotCard)).toBe(true);
        const snapshot = snapshotOf([unreachable]);
        expect(eligibleMarkets(snapshot, { give: ARKADE_BTC, take: LIGHTNING_BTC })).toEqual([]);
    });

    it("skips a market whose receive side the solver cannot pay out", () => {
        const noPayout: DiscoveredMarket = {
            ...lightningCard,
            max_quote_amount: "0",
            min_quote_amount: "0",
        };
        const snapshot = snapshotOf([noPayout]);
        expect(eligibleMarkets(snapshot, { give: ARKADE_BTC, take: LIGHTNING_BTC })).toEqual([]);
        // The other direction still works: it is that side that is disabled.
        expect(eligibleMarkets(snapshot, { give: LIGHTNING_BTC, take: ARKADE_BTC })).toHaveLength(
            1,
        );
    });

    it("bounds the take leg against the card, and only when a pin names it", () => {
        const snapshot = snapshotOf([lightningCard]);
        const legs = { give: ARKADE_BTC, take: LIGHTNING_BTC } as const;
        // The card serves 1000..50_000_000 on either side.
        expect(eligibleMarkets(snapshot, legs, undefined, 100_000n)).toHaveLength(1);
        expect(eligibleMarkets(snapshot, legs, undefined, 50_000_001n)).toEqual([]);
        expect(eligibleMarkets(snapshot, legs, undefined, 999n)).toEqual([]);
        // An unpinned read is not a zero-sized trade; it still serves.
        expect(eligibleMarkets(snapshot, legs, undefined, undefined)).toHaveLength(1);
    });

    it("filters on the registry URL, exactly", () => {
        const snapshot = snapshotOf([lightningCard, rivalLightningCard]);
        const both = eligibleMarkets(snapshot, { give: ARKADE_BTC, take: LIGHTNING_BTC });
        expect(both).toHaveLength(2);

        const allowed = eligibleMarkets(
            snapshot,
            { give: ARKADE_BTC, take: LIGHTNING_BTC },
            { allowedRegistries: [rivalLightningCard.source] },
        );
        expect(allowed.map((c) => c.card.solver)).toEqual(["rival"]);

        const none = eligibleMarkets(
            snapshot,
            { give: ARKADE_BTC, take: LIGHTNING_BTC },
            // A hostname is not a source, and the match is exact on purpose.
            { allowedRegistries: ["registry.example"] },
        );
        expect(none).toEqual([]);
    });
});

describe("choosing between candidates", () => {
    const candidates = () =>
        eligibleMarkets(snapshotOf([lightningCard, rivalLightningCard]), {
            give: ARKADE_BTC,
            take: LIGHTNING_BTC,
        });

    it("takes discovery's ranking when policy says nothing", () => {
        expect(chooseMarket(candidates())?.card.solver).toBe("frenchman");
    });

    it("lets policy pick another candidate", () => {
        const selectMarket = vi.fn((all: readonly MarketCandidate[]) =>
            all.find((c) => c.card.solver === "rival"),
        );
        expect(chooseMarket(candidates(), { selectMarket })?.card.solver).toBe("rival");
        expect(selectMarket).toHaveBeenCalledWith(expect.arrayContaining([]));
    });

    it("treats a veto as an empty set rather than an error of its own", () => {
        expect(chooseMarket(candidates(), { selectMarket: () => undefined })).toBeUndefined();
    });

    it("refuses a card that was never a candidate", () => {
        expect(() =>
            chooseMarket(candidates(), {
                selectMarket: () => ({
                    card: spotCard,
                    give: "base",
                    backend: "feed",
                    key: marketKeyOf(spotCard),
                }),
            }),
        ).toThrow(/not among the candidates/);
    });
});

describe("the provenance a card leaves on a quote", () => {
    it("carries the registry, the solver, the key and the snapshot's freshness", () => {
        const snapshot = snapshotOf([lightningCard]);
        const [candidate] = eligibleMarkets(snapshot, { give: ARKADE_BTC, take: LIGHTNING_BTC });
        expect(marketRefOf(candidate, snapshot.ref)).toEqual({
            kind: "card",
            key: "arkade:btc/lightning:btc",
            backend: "rfq",
            source: lightningCard.source,
            sourceType: "registry",
            solver: "frenchman",
            discoveryPubkey: lightningCard.discovery_pubkey,
            pair: "BTC/lightning:BTC",
            snapshot: snapshot.ref,
        });
    });
});

describe("BTC on a test network, against cards carrying a CAIP-19 id", () => {
    // The mutinynet registry's `frenchman` card, verbatim: a legacy `id` plus the `caip19_id`
    // discovery keys it by, with BTC under SLIP-44's testnet coin type. `btcOn` once spelled BTC
    // `slip44:0` on every network, so the wallet's BTC -> USDT quote matched neither key.
    const frenchman: DiscoveredMarket = {
        base_asset: {
            id: "btc",
            name: "Bitcoin",
            ticker: "BTC",
            decimals: 8,
            caip19_id: "arkade:mutinynet/slip44:1",
        },
        quote_asset: {
            id: USD_ASSET_ID,
            name: "USDT",
            ticker: "USDT",
            decimals: 2,
            caip19_id: `arkade:mutinynet/asset:${USD_ASSET_ID}`,
        },
        price_feed: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
        price_feed_schema: { type: "json", price_path: "/bitcoin/usd" },
        price_decimals: 6,
        fee_bps: 30,
        min_base_amount: "330",
        max_base_amount: "10000000",
        min_quote_amount: "1",
        max_quote_amount: "10000000",
        solver: "frenchman",
        pair: "BTC/USDT",
        source: "https://arkade-os.github.io/solver-registry/mutinynet.json",
        sourceType: "registry",
    };
    const usdt = arkadeAsset("mutinynet", asset.AssetId.fromString(USD_ASSET_ID));

    it("finds the card from the wallet's own BTC id", () => {
        const legs = {
            give: toDiscoveryLeg(btcOn("arkade", "mutinynet")),
            take: toDiscoveryLeg(usdt),
        };
        const candidates = eligibleMarkets(snapshotOf([frenchman, lightningCard]), legs);
        expect(candidates.map((c) => c.card)).toEqual([frenchman]);
        expect(candidates[0]).toMatchObject({ give: "base", backend: "feed" });
    });

    it("still finds a legacy card with no CAIP-19 id, by its corridor key", () => {
        // The `ln-solver-mutinynet` cards: `id: "btc"` and nothing else.
        const legs = {
            give: toDiscoveryLeg(btcOn("arkade", "mutinynet")),
            take: toDiscoveryLeg(btcOn("bolt11", "mutinynet")),
        };
        const candidates = eligibleMarkets(snapshotOf([frenchman, lightningCard]), legs);
        expect(candidates.map((c) => c.card)).toEqual([lightningCard]);
    });

    it("refuses the old spelling outright rather than matching nothing", () => {
        expect(() => toDiscoveryLeg("arkade:mutinynet/slip44:0")).toThrowError(
            expect.objectContaining({ name: "UnsupportedRoute" }),
        );
    });
});
