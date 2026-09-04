/**
 * `cross-asset` — pay an asset the wallet does not hold, by swapping into it
 * first.
 *
 * ## Composition fits inside a rail
 *
 * The obvious reading of "swap, then pay" is that the router needs a
 * multi-hop primitive: two `RouteQuote`s chained, with a way to price the pair.
 * It does not, and this rail is the demonstration. Both legs are known at
 * quote time — `quoteOffer` prices the swap from the market's own feed, and
 * the delivery leg is an off-chain transfer with no counterparty fee — so the
 * rail prices them together into one `RouteQuote` and reports the swap on
 * `RouteResult.swapId`, which {@link RouteResult} already had a slot for.
 *
 * Nothing about the router had to change. That is the argument for keeping
 * composition out of it: a hop is only routable if it is quotable, and a rail
 * that owns both hops can quote both. Pushing this into the router would mean
 * inventing a quote-composition rule that every future rail has to satisfy,
 * for one caller.
 *
 * What DID have to change is the request and quote shape, and only because a
 * cross-asset route spends one asset and delivers another: `total = amount +
 * fee` cannot hold across two units, which is why `RouteQuote.assets` carries
 * `spent` and `delivered` separately rather than a third triple.
 *
 * ## What this rail does not do
 *
 * Asset → asset in one offer. `createOffer` refuses anything but BTC↔asset
 * ("set exactly one of wantAsset or offerAsset"), so paying USDX out of EURX
 * is two offers. That is still a rail-internal concern — it is more legs, not
 * a different shape — but it is not implemented here, and `available()` says
 * so by requiring the wallet's BTC balance to cover the deposit.
 *
 * ## Order
 *
 * `send()` funds the offer, waits for a filler to deliver, and only then pays
 * the recipient. The wait is injected (`awaitFill`) because observing a fill is
 * `watchOfferSwaps`/`restoreAssetSwaps`' job and this package does not start a
 * watcher of its own. `persist` runs before the offer is funded, for the same
 * reason it does on the send rails: an offer funded without a record is one
 * `cancelOffer` cannot rebuild.
 */
import type { DiscoveredMarket, OfferPlan, Side } from "@arkade-os/solver-discovery";
import type { Asset, PaymentRail, RouteQuote, RouterContext } from "@arkade-os/sdk";
import {
    arkTarget,
    asset as assetExt,
    assetsOf,
    makeHandle,
    resolveAssetAmount,
} from "@arkade-os/sdk";
import { createOffer } from "../offer";
import { findMarket, validatePlan, type PlanError } from "../markets";
import { BTC_ASSET_ID } from "../store";

/** This rail's id, and what `RouterPreferences.priority` ranks it by. */
export const CROSS_ASSET_RAIL = "cross-asset";

/** The offer this rail funded, and the payment it was funded for. */
export interface CrossAssetSwap {
    /** `createOffer`'s encoded offer — the only input `cancelOffer` needs. */
    offerHex: string;
    /** The swap address the deposit went to. */
    address: string;
    swapPkScript: Uint8Array;
    /** Sats deposited into the offer. */
    depositSats: number;
    /** What the offer buys, and what the recipient is then paid. */
    asset: Asset;
    /** Where the asset goes once the offer fills. */
    payTo: string;
    plan: OfferPlan;
}

export interface CrossAssetRailDeps {
    /** Arkade Service REST URL — `createOffer` reads `getInfo()` from it. */
    arkServerUrl: string;
    /** Markets to price and route over. `discoverMarkets` already caches. */
    discover(): Promise<DiscoveredMarket[]>;
    /**
     * Price the swap leg. Pass `quoteOffer` from `@arkade-os/solver-discovery`,
     * partially applied with whatever feed fetch the app uses — `markets.ts`
     * ships `makeCachedFeedFetch` for exactly this.
     */
    quote(market: DiscoveredMarket, give: Side, wantAmount: bigint): Promise<OfferPlan>;
    /** Spendable sats, for the deposit the plan asks for. */
    btcBalance(): Promise<bigint>;
    /** The server's dust limit — `validatePlan` protects the BTC leg with it. */
    dust(): Promise<bigint>;
    /** Write the offer down BEFORE it is funded: an offer funded without a
     *  record is one `cancelOffer` cannot rebuild. */
    persist(swap: CrossAssetSwap): Promise<void>;
    /** Resolve once a filler has delivered the asset to this wallet. */
    awaitFill(swap: CrossAssetSwap): Promise<void>;
    /** Sats the delivery leg carries. Defaults to the SDK's dust carrier. */
    carrierSats?: number;
    /** Co-signer key override for the offer covenant. */
    emulatorPubkey?: string;
}

/** Sats the delivery output carries when nothing else says. Mirrors
 *  `Recipient.amount`'s own default. */
const DEFAULT_CARRIER_SATS = 330;

/**
 * The asset id as `createOffer` needs it, or undefined when it is not one.
 *
 * `Asset.assetId` is a hex STRING (that is what `Wallet.send` takes), and
 * `createOffer` wants an `AssetId` — it reads `.txid` and `.groupIndex` off it
 * to bind the covenant, so handing it the string would build an offer with an
 * undefined want-asset rather than fail. Ids are 34 bytes; `fromString` throws
 * on anything else, and returning undefined here lets `available()` drop the
 * rail instead of the router.
 */
const parseAssetId = (assetId: string): assetExt.AssetId | undefined => {
    try {
        return assetExt.AssetId.fromString(assetId);
    } catch {
        return undefined;
    }
};

/**
 * The rail. Register it after `ark-asset`, which pays out of a balance the
 * wallet already has:
 *
 * ```ts
 * router.options(req, { priority: ["ark-asset", "cross-asset"] });
 * ```
 *
 * Both match an Arkade address carrying an asset amount, so `options()` can
 * surface both and the app can offer "pay from your USDX" beside "buy USDX and
 * pay". Ranking `ark-asset` first is a preference, not a restriction.
 */
export function crossAssetRail(deps: CrossAssetRailDeps): PaymentRail {
    /**
     * The plan for THIS payment, or a reason there is none. Never throws for a
     * routing reason — `available()` reads undefined as "not this rail" — and
     * `quote()` re-reads the same `PlanError` to say which.
     */
    const planFor = async (
        asset: Asset,
    ): Promise<{ plan: OfferPlan; error?: PlanError } | undefined> => {
        const markets = await deps.discover();
        // Keyed on BTC deliberately, and that keying IS the BTC-only
        // restriction: `findMarket` matches a market's asset ids exactly, in
        // either orientation, so anything it returns for `(btc, asset)` has BTC
        // on the side this rail gives. A EURX/USDX market is not returned at
        // all, which is correct — `createOffer` would refuse it ("set exactly
        // one of wantAsset or offerAsset"). A separate give-side check here
        // would be unreachable, so there is not one.
        const found = findMarket(markets, BTC_ASSET_ID, asset.assetId);
        const market = found?.market;
        if (!market) return undefined;
        const plan = await deps.quote(market, found.give, asset.amount);
        const [balance, dust] = await Promise.all([deps.btcBalance(), deps.dust()]);
        return { plan, error: validatePlan(plan, balance, dust) };
    };

    return {
        id: CROSS_ASSET_RAIL,
        match: (req) => arkTarget(req.raw) !== undefined,

        available: async (req) => {
            // Only for a request naming exactly one well-formed asset; a
            // malformed one is `ark-asset`'s to reject with a named error, not
            // this rail's to drop twice over.
            const assets = assetsOf(req);
            if (assets.length !== 1) return false;
            const [asset] = assets;
            if (asset.assetId === BTC_ASSET_ID) return false;
            if (typeof asset.amount !== "bigint" || asset.amount <= 0n) return false;
            // Parsed here so an id `createOffer` could not bind drops the rail
            // rather than failing at send time, with the offer already funded.
            if (!parseAssetId(asset.assetId)) return false;
            // A discovery or feed failure propagates: the router catches it,
            // warns, and drops this rail, which is the intended fallback.
            const planned = await planFor(asset);
            return planned !== undefined && planned.error === undefined;
        },

        quote: async (req, ctx: RouterContext): Promise<RouteQuote> => {
            const payTo = arkTarget(req.raw)!;
            const asset = resolveAssetAmount(CROSS_ASSET_RAIL, req);
            const wantAsset = parseAssetId(asset.assetId);
            if (!wantAsset) {
                throw new Error(
                    `${CROSS_ASSET_RAIL}: ${asset.assetId} is not an asset id ` +
                        `(expected 34 bytes of hex)`,
                );
            }
            const planned = await planFor(asset);
            if (!planned) {
                throw new Error(`${CROSS_ASSET_RAIL}: no market swaps BTC into ${asset.assetId}`);
            }
            if (planned.error) {
                throw new Error(
                    `${CROSS_ASSET_RAIL}: cannot swap into ${asset.assetId} — ${planned.error}`,
                );
            }
            const { plan } = planned;
            const depositSats = Number(plan.deposit.atomic);
            const carrier = deps.carrierSats ?? DEFAULT_CARRIER_SATS;

            return {
                railId: CROSS_ASSET_RAIL,
                // The BTC leg, as on every rail: what leaves the wallet in
                // sats. `amount` is the carrier the recipient's output holds,
                // `fee` the sats the swap consumes to buy the asset — spent on
                // the user's behalf and never delivered, which is exactly what
                // `fee` means everywhere else.
                amount: carrier,
                fee: depositSats,
                total: depositSats + carrier,
                assets: {
                    delivered: asset,
                    // A DIFFERENT asset from `delivered` — the whole reason
                    // these are two fields and not an amount/fee/total triple.
                    spent: { assetId: BTC_ASSET_ID, amount: plan.deposit.atomic },
                },
                meta: {
                    market: plan.market.pair,
                    priceDisplay: plan.priceDisplay,
                    give: plan.give,
                },
                send: async () =>
                    makeHandle(CROSS_ASSET_RAIL, async (emit) => {
                        const offer = await createOffer(ctx.wallet, deps.arkServerUrl, {
                            wantAmount: asset.amount,
                            wantAsset,
                            ...(deps.emulatorPubkey ? { emulatorPubkey: deps.emulatorPubkey } : {}),
                        });
                        const swap: CrossAssetSwap = {
                            offerHex: offer.offerHex,
                            address: offer.address,
                            swapPkScript: offer.swapPkScript,
                            depositSats,
                            asset,
                            payTo,
                            plan,
                        };
                        // Persist FIRST: `cancelOffer` rebuilds the covenant
                        // from `offerHex` and nothing else, so an offer funded
                        // without a record is one nobody can cancel.
                        await deps.persist(swap);
                        await ctx.wallet.send({
                            address: offer.address,
                            amount: depositSats,
                            extensions: [offer.extension],
                        });
                        emit({ status: "sent" });

                        // A filler delivers the asset to this wallet; only then
                        // is there anything to pay the recipient with.
                        await deps.awaitFill(swap);
                        const txid = await ctx.wallet.send({
                            address: payTo,
                            amount: carrier,
                            assets: [asset],
                        });
                        const result = {
                            railId: CROSS_ASSET_RAIL,
                            txid,
                            swapId: offer.offerHex,
                        };
                        emit({ status: "settled", result });
                        return result;
                    }),
            };
        },
    };
}
