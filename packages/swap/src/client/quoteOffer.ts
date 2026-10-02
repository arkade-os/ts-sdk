/**
 * The feed-priced backend: an arkade-to-arkade asset swap, priced from the card's own feed with no
 * round trip. The market picks the backend (an asset card that names no rendezvous → feed, otherwise RFQ).
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
    marketLegKey,
    quoteOffer,
    type DiscoveredMarket,
    type OfferPlan,
    type Side,
} from "@arkade-os/solver-discovery";
import { QUOTE_OPTIONS, makeCachedFeedFetch } from "../markets";
import { ASSET_CARRIER_SATS } from "../offer";
import { assetPartOf, BTC_ASSET_PART } from "./assetId";
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
        // What `fund` attaches to an asset deposit and the fill pays an asset want: the plan asks
        // for it back in a BTC payout, and charges it where the card declares a delivered carrier.
        carrierSats: ASSET_CARRIER_SATS,
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
            fee: {
                // The plan's payout returns the deposit's carrier; that part is not proceeds.
                amount: feedSpread(
                    plan,
                    plan.receive.atomic,
                    sellsAssetForBtc(input.endpoints) ? ASSET_CARRIER_SATS : 0n,
                ),
                asset: input.endpoints.take.asset,
            },
        },
        preparation: { backend: "feed", card: candidate.card, plan, give: candidate.give },
    };
};

/**
 * The spread in take-leg units, where it is exact (give units would need a division by price): what
 * the deposit would buy at the feed price with no fee, minus what the trader is actually paid out.
 * `take` is a parameter because the plan is the reference price on both asset backends but the
 * payout is not: a feed quote pays what the plan computed, a negotiated one the solver's `to_amount`.
 *
 * `carrierSats` is what an asset deposit carried to the filler, netted off a BTC payout: a payout
 * that returns it charges nothing for it, and one that does not shows it as fee.
 */
export const feedSpread = (plan: OfferPlan, take: bigint, carrierSats = 0n): bigint => {
    const payout = take > carrierSats ? take - carrierSats : 0n;
    const fair = computeWantAmount({
        deposit: plan.deposit.atomic,
        give: plan.give,
        price: plan.price,
        feeBps: 0,
        safetyBps: 0,
    });
    const spread = fair - payout;
    return spread > 0n ? spread : 0n;
};

/** Asset in, BTC out: the only shape whose carrier is denominated like the fee. */
const sellsAssetForBtc = (endpoints: FeedQuoteInput["endpoints"]): boolean =>
    assetPartOf(endpoints.give.asset) !== BTC_ASSET_PART &&
    assetPartOf(endpoints.take.asset) === BTC_ASSET_PART;

/** When the price behind this card was read, plus the TTL it is good for. */
const feedExpiry = (card: DiscoveredMarket, feed: FeedFetch, now: number): number => {
    const readAt = card.price_feed === undefined ? undefined : feed.fetchedAt(card.price_feed);
    // a same-asset market fetches nothing (price is identically 1), so its life starts now
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
