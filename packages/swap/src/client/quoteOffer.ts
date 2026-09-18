/**
 * The feed-priced backend: an arkade-to-arkade card that named no rendezvous.
 *
 * A card with relays is RFQ (`quoteViaRfq`). This module is the leftover:
 * the card's feed, no round trip, same offer covenant.
 *
 * **The margin.** `quoteOffer` defaults `safetyBps` to 50, the package exports
 * `QUOTE_OPTIONS = { safetyBps: 0 }` and the wallet passes it, and the v1 facade
 * passes neither — so one card priced two different offers depending on which
 * path built it. `Quote.fee` is one number with one definition, so this picks:
 * the package constant, no cushion. A safety margin is a pre-payment against
 * price drift between quote and fill, and that drift is the solver's risk to
 * manage rather than the trader's to prepay; charging it would also inflate the
 * fee a verb's `maxFee` ceiling is compared against, which is a ceiling on what
 * the trader pays, not on what the client padded.
 *
 * **The expiry.** §3.1 makes `expiresAt` non-optional and a feed-priced quote
 * has no `valid_until` to inherit — `OfferPlan` carries no expiry at all. The
 * only staleness bound in the whole path is the feed cache's TTL, so that is
 * what the quote's life is minted from: the moment the feed value was actually
 * read from upstream, plus the TTL. A quote whose price is thirty seconds old
 * expires when the price does, which is the honest bound; the policy floor then
 * applies to a number the client chose rather than one a solver asserted.
 */
import {
    computeWantAmount,
    marketLegKey,
    quoteOffer,
    type DiscoveredMarket,
    type OfferPlan,
    type Side,
} from "@arkade-os/solver-discovery";
import { QUOTE_OPTIONS, makeCachedFeedFetch } from "../markets";
import type { DiscoveryLeg } from "./aliases";
import { QuoteVerificationFailed } from "./errors";
import type { MarketCandidate } from "./market";
import type { SwapPolicy } from "./policy";
import type { CardMarketRef, Quote, QuoteId, ResolvedEndpoint } from "./quote";
import { assembleRoute } from "./resolve";
import type { PinnedAmount } from "./quote";
import { verifyQuoteTtl } from "./verify";

/**
 * How long a feed value is reused, and therefore how long a quote priced from
 * one lives.
 *
 * The same number in both roles on purpose: a quote is only as fresh as the
 * price behind it, and two TTLs would let a quote outlive the value it quoted.
 */
export const FEED_TTL_MS = 30_000;

/** A fetch that caches feed values, and remembers when each was really read. */
export interface FeedFetch {
    readonly fetch: typeof fetch;
    /** Unix ms the value behind `url` was last read from upstream. */
    fetchedAt(url: string): number | undefined;
}

/**
 * The client's feed fetcher.
 *
 * The upstream probe sits INSIDE the cache rather than around it, which is what
 * makes `fetchedAt` mean what it says: the cache calls through only on a miss,
 * so the recorded time is the age of the value that was served, not the time it
 * was served. Wrapping the other way would restamp every cache hit as fresh and
 * hand back a quote whose expiry outlived its price.
 */
export const feedFetch = (base: typeof fetch = fetch): FeedFetch => {
    const at = new Map<string, number>();
    const probe: typeof fetch = async (input, init) => {
        at.set(input instanceof Request ? input.url : String(input), Date.now());
        return base(input, init);
    };
    return { fetch: makeCachedFeedFetch(FEED_TTL_MS, probe), fetchedAt: (url) => at.get(url) };
};

/** What `accept()` (M4) needs back from a feed-priced quote. */
export interface OfferPreparation {
    readonly backend: "feed";
    readonly card: DiscoveredMarket;
    /** The plan the offer covenant is built from: both amounts and both assets. */
    readonly plan: OfferPlan;
    readonly give: Side;
}

export interface FeedQuoteInput {
    readonly quoteId: QuoteId;
    readonly candidate: MarketCandidate;
    readonly market: CardMarketRef;
    readonly legs: { readonly give: DiscoveryLeg; readonly take: DiscoveryLeg };
    readonly endpoints: { readonly give: ResolvedEndpoint; readonly take: ResolvedEndpoint };
    readonly amount?: PinnedAmount;
    readonly feed: FeedFetch;
    readonly policy?: SwapPolicy;
    /** Unix seconds. */
    readonly now: number;
}

export const quoteFromFeed = async (
    input: FeedQuoteInput,
): Promise<{ quote: Quote; preparation: OfferPreparation }> => {
    const { candidate, amount } = input;
    if (amount === undefined) {
        // No invoice exists on this route to pin one, so the caller is the only
        // possible source. Caller input, not a swap-boundary refusal.
        throw new Error("an asset swap needs an amount and the side it pins");
    }

    const plan = await quoteOffer(candidate.card, {
        give: candidate.give,
        ...(amount.on === "give" ? { giveAmount: amount.value } : { wantAmount: amount.value }),
        ...QUOTE_OPTIONS,
        fetchImpl: input.feed.fetch,
    });

    // The pair check, on the backend that has no wire pair to compare: the plan
    // that came back must price the two legs that were asked for. It is the same
    // invariant `expectQuote` enforces over the RFQ string — a quote for another
    // market is not this market's quote — reached through the only identity a
    // plan carries, its two asset ids.
    verifyPlanLegs(plan, input.legs, candidate.give);

    const expiresAt = feedExpiry(candidate.card, input.feed, input.now);
    verifyQuoteTtl({
        quoteId: input.quoteId,
        expiresAt,
        now: input.now,
        floorSeconds: input.policy?.quoteTtlFloorSeconds,
    });

    const route = assembleRoute(
        { ...input.endpoints.give, instrument: { kind: "wallet" } },
        { ...input.endpoints.take, instrument: { kind: "wallet" } },
    );

    return {
        quote: {
            id: input.quoteId,
            route,
            give: { asset: input.endpoints.give.asset, amount: plan.deposit.atomic },
            take: { asset: input.endpoints.take.asset, amount: plan.receive.atomic },
            market: input.market,
            expiresAt,
            fee: {
                amount: feedSpread(plan, plan.receive.atomic),
                asset: input.endpoints.take.asset,
            },
        },
        preparation: { backend: "feed", card: candidate.card, plan, give: candidate.give },
    };
};

/**
 * The spread, in the units the trader receives.
 *
 * Denominated on the take leg because that is where it is exact: the two legs
 * of an asset swap carry different assets, so a fee stated in give units would
 * be this subtraction divided by the price — a rounding introduced for the sake
 * of a denomination nobody asked for. What it measures is the concession: what
 * the same deposit would have bought at the feed price with no fee at all,
 * minus what the trader is actually paid out.
 *
 * `take` is a parameter rather than read off the plan because the plan is the
 * reference price on both asset backends and the payout is not: a feed-priced
 * quote pays out what the plan computed, and a negotiated one pays out the
 * solver's `to_amount`. Measuring the second against the first is what makes a
 * cross-asset fee a number at all — subtracting the two legs is meaningless
 * when they carry different assets, so the card's own advertised price is the
 * only reference either backend has.
 */
export const feedSpread = (plan: OfferPlan, take: bigint): bigint => {
    const fair = computeWantAmount({
        deposit: plan.deposit.atomic,
        give: plan.give,
        price: plan.price,
        feeBps: 0,
        safetyBps: 0,
    });
    const spread = fair - take;
    return spread > 0n ? spread : 0n;
};

/** When the price behind this card was read, plus the TTL it is good for. */
const feedExpiry = (card: DiscoveredMarket, feed: FeedFetch, now: number): number => {
    const readAt = card.price_feed === undefined ? undefined : feed.fetchedAt(card.price_feed);
    // A same-asset corridor market fetches nothing — its price is identically 1
    // — so there is no feed age to inherit and the quote's life starts now.
    const from = readAt === undefined ? now : Math.floor(readAt / 1000);
    return from + FEED_TTL_MS / 1000;
};

/**
 * The plan prices the legs that were asked for, in the orientation asked for.
 *
 * Compared through `marketLegKey` rather than the raw `AssetInfo.id`, because a
 * card spells its sides two ways and both reach here: the canonical CAIP-19 id
 * a current registry publishes, and the legacy `"btc"`-or-68-hex form an older
 * card carries beside a `*_corridor` field. That helper normalises the second
 * into `<corridor>:<id>` and leaves the first alone, which is exactly the pair
 * of spellings `eligibleMarkets` already selects by — so this check accepts the
 * cards the routing read accepted, instead of refusing a canonical one as a
 * pair mismatch it never was.
 */
export const verifyPlanLegs = (
    plan: OfferPlan,
    legs: { give: DiscoveryLeg; take: DiscoveryLeg },
    give: Side,
): void => {
    const take: Side = give === "base" ? "quote" : "base";
    const spelled = (side: Side): string => marketLegKey(plan.market, side);
    const names = (side: Side, leg: DiscoveryLeg): boolean =>
        spelled(side) === leg.marketId || spelled(side) === `${leg.corridor}:${leg.assetId}`;
    if (plan.give !== give || !names(give, legs.give) || !names(take, legs.take)) {
        throw new QuoteVerificationFailed(
            "pair",
            `${legs.give.marketId}->${legs.take.marketId}`,
            `${spelled(give)}->${spelled(take)}`,
        );
    }
};
