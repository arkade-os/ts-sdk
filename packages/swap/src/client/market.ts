/**
 * Market resolution: `(give.asset, take.asset, corridors)` to the card that
 * prices the swap, and the provenance that card leaves on the quote.
 *
 * The lookup itself is discovery's — `selectMarkets` matches a leg pair — and
 * this module supplies
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

/** Which backend a card selects — the card decides it, never the client. */
export const marketBackendOf = (card: DiscoveredMarket): MarketBackend =>
    isRfqMarket(card) ? "rfq" : "feed";

/**
 * The cards on a snapshot this client may act on at all, before any pair is
 * named: the policy's registry allowlist, then addressability.
 *
 * Shared by the routing read and `markets()`, so the escape hatch cannot offer
 * a card the quote path would then refuse.
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
 * Every card on the snapshot that serves this leg pair, best-ranked first,
 * after policy.
 *
 * The allowed-registry filter runs first and matches `source` exactly. It is
 * `source` and not `discovery_pubkey` because the latter is the field a cached
 * card carries unvalidated: filtering trust on untrusted content would give the
 * allowlist the shape of a check and none of the effect.
 *
 * `takeAmount` is the pinned trade size on the leg the trader receives, and it
 * is what makes a card's own `min/max` bounds mean something: without it a
 * snapshot serving the pair answers "eligible" for any size, and the swap rails'
 * documented self-healing — an out-of-range amount drops the rail at
 * `available()` and the collaborative exit wins — never fires.
 *
 * @param takeAmount The pin on the TAKE leg only, which is the side `wantSide`
 *   names. Omitting it skips the bounds entirely — an unpinned read is not a
 *   zero-sized trade. A GIVE-side pin is deliberately not converted and passed:
 *   that would need a price this read does not have, so a give-side amount past
 *   a card's ceiling still answers `eligible: 1` here and is refused by the
 *   solver instead. That asymmetry is the known sharp edge of this parameter.
 */
export const eligibleMarkets = (
    snapshot: DiscoverySnapshot,
    legs: { give: DiscoveryLeg; take: DiscoveryLeg },
    policy?: SwapPolicy,
    takeAmount?: bigint,
): MarketCandidate[] => {
    const markets = usableMarkets(snapshot, policy);

    const { give, take } = legs;
    // Same leg on both sides is not a swap — and it is the LEG that has to
    // differ, not the asset: `lightning:btc -> arkade:btc` is the same asset id
    // on two corridors and is the corridor's whole purpose.
    if (give.corridor === take.corridor && give.assetId === take.assetId) return [];

    const oriented = (side: Side): MarketCandidate[] => {
        const base = side === "base" ? give : take;
        const quote = side === "base" ? take : give;
        const selection = {
            // The trader receives the take leg, so that side must be one the
            // solver can pay out; a direction nobody solves yields no market.
            wantSide: side === "base" ? "quote" : "base",
            ...(takeAmount === undefined ? {} : { wantAmount: takeAmount }),
        } as const;

        // New indexes identify legs with CAIP-19. Keep accepting snapshots
        // produced from legacy cards too: solver-discovery deliberately keeps
        // their old `<corridor>:<short-id>` key, while the RFQ wire still needs
        // the short id carried by `assetId`.
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
        const selected = [...canonical, ...legacy].filter(
            (card, index, all) => all.indexOf(card) === index,
        );

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

/** Narrow a `MarketRef` to the card arm — the only one minted today. */
export const isCardMarket = (market: MarketRef): market is CardMarketRef => market.kind === "card";

/**
 * A market as the v2 client publishes it — one shape with {@link CardMarketRef},
 * the type `Quote.market` already points at.
 *
 * `markets()` is the escape hatch, and its return is deliberately the same card
 * a quote cites: a caller picking a market for a custom `quote()` reads the same
 * provenance the quote will carry, key for key and snapshot for snapshot.
 * Discovery's own `DiscoveredMarket` never crosses the v2 root — its asset ids
 * (`"btc"` or a 68-hex string) and its display `pair` are exactly the vocabulary
 * the alias layer exists to keep off it. The honest limit of the escape hatch
 * is that it carries no discovery asset id; an integrator needing the native
 * cards keeps the package's own discovery reader below the public surface.
 */
export type Market = CardMarketRef;
