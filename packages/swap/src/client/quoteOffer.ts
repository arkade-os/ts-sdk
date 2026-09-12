/**
 * The feed-priced backend: an arkade-to-arkade asset swap, priced from the
 * card's own feed with no round trip to anybody.
 *
 * The market picks the backend — a card with both legs on arkade prices from
 * its feed, and one with a leg off it is negotiated over RFQ — so nothing here
 * is a client switch. What this module owns are the two things the offer path
 * has never had an answer for.
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
            fee: { amount: spreadOf(plan), asset: input.endpoints.take.asset },
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
 * minus what the plan actually pays out.
 */
const spreadOf = (plan: OfferPlan): bigint => {
    const fair = computeWantAmount({
        deposit: plan.deposit.atomic,
        give: plan.give,
        price: plan.price,
        feeBps: 0,
        safetyBps: 0,
    });
    const spread = fair - plan.receive.atomic;
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

/** The plan prices the legs that were asked for, in the orientation asked for. */
const verifyPlanLegs = (
    plan: OfferPlan,
    legs: { give: DiscoveryLeg; take: DiscoveryLeg },
    give: Side,
): void => {
    const expected = `${legs.give.assetId}->${legs.take.assetId}`;
    const priced = `${plan.deposit.asset.id}->${plan.receive.asset.id}`;
    if (expected !== priced || plan.give !== give) {
        throw new QuoteVerificationFailed("pair", expected, priced);
    }
};
