/**
 * `cross-asset` — pay an asset the wallet does not hold, by swapping into it
 * first. Both legs are quotable up front, so they price into one `RouteQuote`
 * and the router needs no multi-hop primitive.
 *
 * BTC -> asset only: `createOffer` refuses anything but BTC<->asset, and
 * keying `findMarket` on BTC is what enforces that.
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

export const CROSS_ASSET_RAIL = "cross-asset";

/** The two states need different recovery: a `"quoted"` record whose offer
 *  never filled is cancelled; a `"filled"` one owes the recipient a send. */
export type CrossAssetPhase = "quoted" | "filled";

export interface CrossAssetSwap {
    phase: CrossAssetPhase;
    offerHex: string;
    address: string;
    swapPkScript: Uint8Array;
    depositSats: number;
    asset: Asset;
    payTo: string;
    plan: OfferPlan;
}

export interface CrossAssetRailDeps {
    arkServerUrl: string;
    /** Called by `available()` and again by `quote()`; pass the caching
     *  `discoverMarkets`, not a bare registry fetch. */
    discover(): Promise<DiscoveredMarket[]>;
    quote(market: DiscoveredMarket, give: Side, wantAmount: bigint): Promise<OfferPlan>;
    btcBalance(): Promise<bigint>;
    dust(): Promise<bigint>;
    /** Called twice, both before an irreversible step: `"quoted"` before the
     *  offer is funded, `"filled"` after delivery and before the recipient is
     *  paid. Keyed by `offerHex`, stable across both. */
    persist(swap: CrossAssetSwap): Promise<void>;
    /** Resolve once a filler has delivered the asset to this wallet.
     *
     *  OPEN QUESTION for review: is an injected promise the right seam, or
     *  should the rail take a `watchOfferSwaps` handle? No deadline is applied
     *  here, and resolving on a timeout rather than rejecting would make the
     *  rail pay from whatever the wallet then holds. */
    awaitFill(swap: CrossAssetSwap): Promise<void>;
    carrierSats?: number;
    emulatorPubkey?: string;
}

const DEFAULT_CARRIER_SATS = 330;

const parseAssetId = (assetId: string): assetExt.AssetId | undefined => {
    try {
        return assetExt.AssetId.fromString(assetId);
    } catch {
        return undefined;
    }
};

/** Rank after `ark-asset`, which pays from a balance already held. Both match,
 *  so `options()` can offer "pay from your USDX" beside "buy USDX and pay". */
export function crossAssetRail(deps: CrossAssetRailDeps): PaymentRail {
    const planFor = async (
        asset: Asset,
    ): Promise<{ plan: OfferPlan; error?: PlanError } | undefined> => {
        const markets = await deps.discover();
        // The BTC keying IS the BTC-only restriction; a give-side check here
        // would be unreachable.
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
            const assets = assetsOf(req);
            if (assets.length !== 1) return false;
            const [asset] = assets;
            if (asset.assetId === BTC_ASSET_ID) return false;
            if (typeof asset.amount !== "bigint" || asset.amount <= 0n) return false;
            if (!parseAssetId(asset.assetId)) return false;
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
            if (!Number.isSafeInteger(Number(plan.deposit.atomic))) {
                throw new Error(
                    `${CROSS_ASSET_RAIL}: deposit of ${plan.deposit.atomic} does not fit a JS number`,
                );
            }
            const depositSats = Number(plan.deposit.atomic);
            const carrier = deps.carrierSats ?? DEFAULT_CARRIER_SATS;

            return {
                railId: CROSS_ASSET_RAIL,
                // OPEN QUESTION for review: `total = amount + fee` forces the
                // purchase price into `fee`, which reads as a service charge.
                // A third field instead? `assets.spent` labels it correctly.
                amount: carrier,
                fee: depositSats,
                total: depositSats + carrier,
                assets: {
                    delivered: asset,
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
                            phase: "quoted",
                            offerHex: offer.offerHex,
                            address: offer.address,
                            swapPkScript: offer.swapPkScript,
                            depositSats,
                            asset,
                            payTo,
                            plan,
                        };
                        await deps.persist(swap);
                        await ctx.wallet.send({
                            address: offer.address,
                            amount: depositSats,
                            extensions: [offer.extension],
                        });
                        emit({ status: "sent" });

                        await deps.awaitFill(swap);
                        // Before paying: "quoted" would say it never filled.
                        await deps.persist({ ...swap, phase: "filled" });
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
