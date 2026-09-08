import type { PaymentRail, RouteQuote, RouterContext } from "../types";
import { arkTarget } from "../targets";
import {
    assertSendableAmount,
    assetsOf,
    resolveAssetAmount,
    tryResolveSendAmount,
} from "../amount";
import { makeHandle } from "../handle";

/** The sats carrier an asset rides on; mirrors `Recipient.amount`'s default. */
export const ASSET_CARRIER_SATS = 330;

/**
 * Off-chain Arkade send of an ASSET — the sibling of `ark`.
 *
 * They split on `available()` rather than `match()` because both legitimately
 * match the address; which one can pay is a question about the amount, so
 * `options()` returns exactly one and their relative priority is immaterial.
 */
export function arkAssetRail(): PaymentRail {
    return {
        id: "ark-asset",
        match: (req) => arkTarget(req.raw) !== undefined,
        // A malformed asset is `quote()`'s to name, not this rail's to drop.
        available: (req) => assetsOf(req).length > 0,
        quote: async (req, ctx: RouterContext): Promise<RouteQuote> => {
            const address = arkTarget(req.raw)!;
            const asset = resolveAssetAmount("ark-asset", req);
            // A stated amount is validated, never defaulted: `0` is not "pick one".
            if (req.amount !== undefined) assertSendableAmount("ark-asset", req.amount);
            const carrier = tryResolveSendAmount(req.raw, req.amount) ?? ASSET_CARRIER_SATS;
            return {
                railId: "ark-asset",
                amount: carrier,
                fee: 0,
                total: carrier,
                assets: { delivered: asset, spent: asset },
                send: async () =>
                    makeHandle("ark-asset", async (emit) => {
                        const txid = await ctx.wallet.send({
                            address,
                            amount: carrier,
                            assets: [asset],
                        });
                        const result = { railId: "ark-asset", txid };
                        emit({ status: "settled", result });
                        return result;
                    }),
            };
        },
    };
}
