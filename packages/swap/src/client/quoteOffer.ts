/**
 * The feed-priced backend: an arkade-to-arkade asset swap, priced from the card's own feed with no
 * round trip. The market picks the backend (both legs on arkade → feed, otherwise RFQ).
 *
 * **The margin.** `QUOTE_OPTIONS` (`safetyBps: 0`), not `quoteOffer`'s default 50: price drift
 * between quote and fill is the solver's risk, not the trader's to prepay, and a cushion would
 * inflate the fee that `maxFee` ceilings are compared against.
 *
 * **The expiry.** `expiresAt` is required but `OfferPlan` carries none, so it is minted from the
 * feed cache: the time the value was actually read upstream, plus the TTL — the quote expires when
 * its price does.
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

/** How long a feed value is reused, and so how long a quote priced from it lives — one number, so a
 * quote cannot outlive the value it quoted. */
export const FEED_TTL_MS = 30_000;

/** A fetch that caches feed values, and remembers when each was really read. */
export interface FeedFetch {
    readonly fetch: typeof fetch;
    /** Unix ms the value behind `url` was last read from upstream. */
    fetchedAt(url: string): number | undefined;
}

/**
 * The client's feed fetcher. The probe sits INSIDE the cache, so `fetchedAt` is the age of the value
 * served, not the time it was served; the other way round would restamp every hit as fresh.
 */
export const feedFetch = (base: typeof fetch = fetch): FeedFetch => {
    const at = new Map<string, number>();
    const probe: typeof fetch = async (input, init) => {
        at.set(input instanceof Request ? input.url : String(input), Date.now());
        return base(input, init);
    };
    return { fetch: makeCachedFeedFetch(FEED_TTL_MS, probe), fetchedAt: (url) => at.get(url) };
};

/** What `accept()` needs back from a feed-priced quote. */
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
        // no invoice on this route can pin one; caller input, not a swap-boundary refusal
        throw new Error("an asset swap needs an amount and the side it pins");
    }

    const plan = await quoteOffer(candidate.card, {
        give: candidate.give,
        ...(amount.on === "give" ? { giveAmount: amount.value } : { wantAmount: amount.value }),
        ...QUOTE_OPTIONS,
        fetchImpl: input.feed.fetch,
    });

    // the pair check `expectQuote` does over the RFQ string, via the plan's only identity: its two
    // asset ids — a quote for another market is not this market's quote
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
 * The spread in take-leg units, where it is exact (give units would need a division by price): what
 * the deposit would buy at the feed price with no fee, minus what the plan pays out.
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
    // a same-asset market fetches nothing (price is identically 1), so its life starts now
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
