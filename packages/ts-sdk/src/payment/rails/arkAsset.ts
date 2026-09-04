import type { PaymentRail, RouteQuote, RouterContext } from "../types";
import { arkTarget } from "../targets";
import { assetsOf, resolveAssetAmount, tryResolveSendAmount } from "../amount";
import { makeHandle } from "../handle";

/**
 * Sats a transfer carries when the request names none.
 *
 * An Arkade asset does not move on its own: it rides a sats-carrying output,
 * and `Wallet.send` defaults that carrier to dust. Naming the same number here
 * is what makes the quote honest — the router promises `total` is what leaves
 * the wallet, and the carrier leaves it too.
 *
 * @see Recipient.amount, whose `@defaultValue` this mirrors.
 */
export const ASSET_CARRIER_SATS = 330;

/**
 * Off-chain Arkade send of an ASSET.
 *
 * The sibling of `ark`, and the reason the router needed an asset dimension at
 * all: an Arkade address is the same string whether it is paid in BTC or in an
 * asset, so the target cannot tell them apart. The AMOUNT names the asset —
 * `req.assets` — exactly as it does on `Wallet.send`, whose `Recipient` shape
 * this request mirrors.
 *
 * That is why the two rails split on `available()` rather than on `match()`:
 * both legitimately match the address, and which one can pay is a question
 * about the amount. `ark` drops itself when the request carries an asset, this
 * one drops itself when it does not, and `options()` returns exactly one.
 *
 * Delivery is receiver-exact and free, like `ark`: an off-chain transfer
 * carries no counterparty fee, so `assets.delivered` and `assets.spent` name
 * the same asset and the same quantity, and `fee` is 0.
 *
 * BTC in, BTC out: the sats fields describe the carrier, not zero. A consumer
 * ranking on `total` is ranking on the sats that leave the wallet, which is
 * what it means on every other rail too.
 */
export function arkAssetRail(): PaymentRail {
    return {
        id: "ark-asset",
        match: (req) => arkTarget(req.raw) !== undefined,
        // The split from `ark`: this rail exists only for a request that names
        // an asset. Validating the asset itself is `quote()`'s job — a
        // malformed one must produce a named error, not a silent drop that
        // leaves "no rail for" as the whole explanation.
        available: (req) => assetsOf(req).length > 0,
        quote: async (req, ctx: RouterContext): Promise<RouteQuote> => {
            const address = arkTarget(req.raw)!;
            const asset = resolveAssetAmount("ark-asset", req);
            // The carrier is optional on the request and defaulted here rather
            // than left to `Wallet.send`, so the quote states the sats that
            // will actually leave rather than a zero the send then contradicts.
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
