/**
 * Market resolution: `(give.asset, take.asset, corridors)` to the card that prices the swap, and
 * the provenance that card leaves on the quote.
 *
 * Not `findMarket`: that returns the single best market of one orientation, while
 * `policy.selectMarket` is defined over every eligible card. Both orientations are tried because
 * a registry may publish either leg as base.
 */
import {
    isRfqMarket,
    marketCorridor,
    marketLegKey,
    selectMarkets,
    type DiscoveredMarket,
    type Side,
} from "@arkade-os/solver-discovery";
import type { DiscoveryLeg } from "./aliases";
import type { DiscoverySnapshot } from "./discovery";
import type { SwapPolicy } from "./policy";
import type { CardMarketRef, MarketBackend, MarketRef, SnapshotRef } from "./quote";
import { marketPairLabel } from "../marketShape";

/** One card that can price this route, with what the route needs read off it. */
export interface MarketCandidate {
    readonly card: DiscoveredMarket;
    /** Which side of the card the trader gives; the other side is received. */
    readonly give: Side;
    /** Which backend the card selects. The card decides, never the client. */
    readonly backend: MarketBackend;
    /** The canonical market key — see {@link marketKeyOf}. */
    readonly key: string;
}

/**
 * The market's canonical key, `<corridor>:<id>/<corridor>:<id>`, under rfq-protocol.md §2's leg
 * order: when exactly one leg is arkade it comes first; otherwise the legs sort lexicographically.
 *
 * Derived here rather than from `marketPairKey` (the card's own order): for a card published
 * outside the registry's reducer they disagree, and both negotiation sides subscribe by this key,
 * so a mismatch is not an error either side sees — it is a request nobody answers.
 */
export const marketKeyOf = (card: DiscoveredMarket): string => {
    const base = marketLegKey(card, "base");
    const quote = marketLegKey(card, "quote");
    const baseIsArkade = marketCorridor(card, "base") === "arkade";
    const quoteIsArkade = marketCorridor(card, "quote") === "arkade";
    if (baseIsArkade !== quoteIsArkade) {
        return baseIsArkade ? `${base}/${quote}` : `${quote}/${base}`;
    }
    return base <= quote ? `${base}/${quote}` : `${quote}/${base}`;
};

/**
 * Whether a corridor card can actually be addressed: it needs its discovery key and relays.
 * Dropping it here keeps "no market serves this pair" one answer instead of a transport error
 * that reads like an outage.
 */
export const isAddressable = (card: DiscoveredMarket): boolean =>
    !isRfqMarket(card) ||
    (typeof card.discovery_pubkey === "string" &&
        (card.transports?.nostr?.relays?.length ?? 0) > 0);

/** Which backend a card selects — the card decides it, never the client. */
export const marketBackendOf = (card: DiscoveredMarket): MarketBackend =>
    isRfqMarket(card) ? "rfq" : "feed";

/**
 * The cards on a snapshot this client may act on at all: the policy's registry allowlist, then
 * addressability. Shared with `markets()` so it cannot offer a card the quote path would refuse.
 */
export const usableMarkets = (
    snapshot: DiscoverySnapshot,
    policy?: SwapPolicy,
): DiscoveredMarket[] => {
    const allowed = policy?.allowedRegistries;
    return (
        allowed
            ? snapshot.markets.filter((card) => allowed.includes(card.source))
            : snapshot.markets
    ).filter(isAddressable);
};

/**
 * Every card on the snapshot that serves this leg pair, best-ranked first, after policy.
 *
 * The allowlist matches `source`, not `discovery_pubkey`: the latter is carried unvalidated on a
 * cached card, so filtering trust on it would be a check with no effect.
 *
 * @param takeAmount The pin on the TAKE leg only (the side `wantSide` names), which makes a card's
 *   `min/max` bounds apply so out-of-range amounts drop the rail at `available()`. Omitting it
 *   skips the bounds. A GIVE-side pin is not converted (no price here), so a give-side amount past
 *   a card's ceiling still answers eligible and is refused by the solver — a known sharp edge.
 */
export const eligibleMarkets = (
    snapshot: DiscoverySnapshot,
    legs: { give: DiscoveryLeg; take: DiscoveryLeg },
    policy?: SwapPolicy,
    takeAmount?: bigint,
): MarketCandidate[] => {
    const markets = usableMarkets(snapshot, policy);

    const { give, take } = legs;
    // The LEG must differ, not the asset: `lightning:btc -> arkade:btc` is the corridor's purpose.
    if (give.corridor === take.corridor && give.assetId === take.assetId) return [];

    const oriented = (side: Side): MarketCandidate[] => {
        const base = side === "base" ? give : take;
        const quote = side === "base" ? take : give;
        const selection = {
            // The trader receives the take leg, so the solver must be able to pay that side out.
            wantSide: side === "base" ? "quote" : "base",
            ...(takeAmount === undefined ? {} : { wantAmount: takeAmount }),
        } as const;

        // New indexes key legs by CAIP-19; legacy cards keep `<corridor>:<short-id>`. Accept both.
        const canonical = selectMarkets([...markets], {
            baseId: base.marketId,
            quoteId: quote.marketId,
            ...selection,
        });
        const legacy = selectMarkets([...markets], {
            baseId: `${base.corridor}:${base.assetId}`,
            quoteId: `${quote.corridor}:${quote.assetId}`,
            ...selection,
        });
        const selected = [...new Set([...canonical, ...legacy])];

        return selected.map((card) => ({
            card,
            give: side,
            backend: marketBackendOf(card),
            key: marketKeyOf(card),
        }));
    };

    // Give-as-base first, matching `findMarket`'s own preference order.
    return [...oriented("base"), ...oriented("quote")];
};

/**
 * The card that prices this swap: the best-ranked candidate, or the one the application's policy
 * chose instead. A veto (`undefined` from `selectMarket`) is not an error; it is the same "no
 * market serves this route" as an empty set.
 */
export const chooseMarket = (
    candidates: readonly MarketCandidate[],
    policy?: SwapPolicy,
): MarketCandidate | undefined => {
    if (candidates.length === 0) return undefined;
    if (!policy?.selectMarket) return candidates[0];
    const chosen = policy.selectMarket(candidates);
    if (chosen === undefined) return undefined;
    if (!candidates.includes(chosen)) {
        // A foreign card skipped the pair, corridor and addressability checks behind this list.
        throw new Error("policy.selectMarket returned a market that was not among the candidates");
    }
    return chosen;
};

/** The provenance a candidate leaves on every quote it prices. */
export const marketRefOf = (candidate: MarketCandidate, snapshot: SnapshotRef): CardMarketRef =>
    cardMarketOf(candidate.card, snapshot, candidate.key, candidate.backend);

/** A card's own provenance — the same fields {@link marketRefOf} writes, read
 * off the card rather than off a routed candidate. */
export const cardMarketOf = (
    card: DiscoveredMarket,
    snapshot: SnapshotRef,
    key: string,
    backend: MarketBackend,
): CardMarketRef => ({
    kind: "card",
    key,
    backend,
    source: card.source,
    sourceType: card.sourceType,
    solver: card.solver,
    ...(card.discovery_pubkey === undefined ? {} : { discoveryPubkey: card.discovery_pubkey }),
    pair: card.pair ?? marketPairLabel(card),
    snapshot,
});

/** Narrow a `MarketRef` to the card arm — the only one `quote()` mints. */
export const isCardMarket = (market: MarketRef): market is CardMarketRef => market.kind === "card";

/**
 * A market as the v2 client publishes it — the same {@link CardMarketRef} a quote cites, so a
 * caller picking a market for a custom `quote()` reads the provenance the quote will carry.
 * Discovery's `DiscoveredMarket` never crosses the v2 root, so this carries no discovery asset id.
 */
export type Market = CardMarketRef;
