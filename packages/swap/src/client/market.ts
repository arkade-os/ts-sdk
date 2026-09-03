/**
 * Market resolution: `(give.asset, take.asset, corridors)` to the card that
 * prices the swap, and the provenance that card leaves on the quote.
 *
 * The lookup itself is discovery's — `selectMarkets` matches a leg pair with
 * both corridors, arkade defaulted on either side — and this module supplies
 * the three things around it that the client cannot borrow: the policy filters
 * that run before disclosure, the canonical market key derived under the
 * protocol's own leg order rather than the card's, and the addressability check
 * that keeps an unreachable corridor card out of the candidate set instead of
 * failing at the transport.
 *
 * `findMarket` is not what this calls, and the reason is the candidate set:
 * that helper answers with the single best market of one orientation, and
 * `policy.selectMarket` is defined over every eligible card. Both orientations
 * are tried here for the same reason it tries them — a registry may publish
 * either leg as base.
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
 * The market's canonical key, `<corridor>:<id>/<corridor>:<id>`, under
 * rfq-protocol.md §2's leg order: when exactly one leg is arkade it comes
 * first; when both or neither are, the legs sort lexicographically.
 *
 * Derived here, from the card in hand, rather than taken from `marketPairKey`,
 * which emits the card's own base/quote order. The two agree for every card the
 * registry's reducer validated — it enforces the arkade-as-base half — and
 * disagree for a card published outside it, which is where the miss would be
 * silent: both sides of a published negotiation derive this key independently
 * and subscribe by it, so a key one character apart is not an error either side
 * can report, it is a request nobody answers.
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
 * Whether a corridor card can actually be addressed.
 *
 * A corridor market is negotiated per trade over the rendezvous the card names,
 * so a card missing its key or its relays prices nothing, whatever its feed
 * says. Dropping it here rather than at the transport is what keeps "no market
 * serves this pair" one answer instead of two: an unaddressable card in the
 * candidate set would be selected, disclose nothing, and fail as a transport
 * error that reads like an outage.
 */
export const isAddressable = (card: DiscoveredMarket): boolean =>
    !isRfqMarket(card) ||
    (typeof card.discovery_pubkey === "string" &&
        (card.transports?.nostr?.relays?.length ?? 0) > 0);

const backendOf = (card: DiscoveredMarket): MarketBackend => (isRfqMarket(card) ? "rfq" : "feed");

/**
 * Every card on the snapshot that serves this leg pair, best-ranked first,
 * after policy.
 *
 * The allowed-registry filter runs first and matches `source` exactly. It is
 * `source` and not `discovery_pubkey` because the latter is the field a cached
 * card carries unvalidated: filtering trust on untrusted content would give the
 * allowlist the shape of a check and none of the effect.
 */
export const eligibleMarkets = (
    snapshot: DiscoverySnapshot,
    legs: { give: DiscoveryLeg; take: DiscoveryLeg },
    policy?: SwapPolicy,
): MarketCandidate[] => {
    const allowed = policy?.allowedRegistries;
    const markets = (
        allowed
            ? snapshot.markets.filter((card) => allowed.includes(card.source))
            : snapshot.markets
    ).filter(isAddressable);

    const { give, take } = legs;
    // Same leg on both sides is not a swap — and it is the LEG that has to
    // differ, not the asset: `lightning:btc -> arkade:btc` is the same asset id
    // on two corridors and is the corridor's whole purpose.
    if (give.corridor === take.corridor && give.assetId === take.assetId) return [];

    const oriented = (side: Side): MarketCandidate[] => {
        const base = side === "base" ? give : take;
        const quote = side === "base" ? take : give;
        return selectMarkets([...markets], {
            baseId: base.assetId,
            quoteId: quote.assetId,
            baseCorridor: base.corridor,
            quoteCorridor: quote.corridor,
            // The trader receives the take leg, so that side must be one the
            // solver can pay out; a direction nobody solves yields no market.
            wantSide: side === "base" ? "quote" : "base",
        }).map((card) => ({ card, give: side, backend: backendOf(card), key: marketKeyOf(card) }));
    };

    // Give-as-base first, matching `findMarket`'s own preference order.
    return [...oriented("base"), ...oriented("quote")];
};

/**
 * The card that prices this swap: the best-ranked candidate, or the one the
 * application's policy chose instead.
 *
 * A veto — `undefined` from `selectMarket` — is not an error here. It empties
 * the eligible set, and an empty set is a route no market serves on this
 * snapshot, which is one condition with one answer whether it was emptied by
 * the registry, by the allowlist or by the application.
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
        // A card from somewhere else has not been through the pair, corridor and
        // addressability checks that produced this list, and quoting against it
        // would skip every one of them.
        throw new Error("policy.selectMarket returned a market that was not among the candidates");
    }
    return chosen;
};

/** The provenance a candidate leaves on every quote it prices. */
export const marketRefOf = (candidate: MarketCandidate, snapshot: SnapshotRef): CardMarketRef => ({
    kind: "card",
    key: candidate.key,
    backend: candidate.backend,
    source: candidate.card.source,
    sourceType: candidate.card.sourceType,
    solver: candidate.card.solver,
    ...(candidate.card.discovery_pubkey === undefined
        ? {}
        : { discoveryPubkey: candidate.card.discovery_pubkey }),
    pair: candidate.card.pair,
    snapshot,
});

/** Narrow a `MarketRef` to the card arm — the only one minted today. */
export const isCardMarket = (market: MarketRef): market is CardMarketRef => market.kind === "card";
