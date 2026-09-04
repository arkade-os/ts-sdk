import type { PaymentRail, RouterContext } from "../types";
import { arkTarget } from "../targets";
import { assertNoAssets, assetsOf, resolveSendAmount } from "../amount";
import { makeHandle } from "../handle";

/**
 * Off-chain Arkade send. Matches a bare ark address or the `ark=` param of a
 * unified BIP21 URI, and settles via `Wallet.send`.
 *
 * The only rail that is receiver-exact for free: an off-chain send delivers the
 * full amount and carries no counterparty or on-chain fee, so `fee` is 0 and
 * `total` equals `amount` (see {@link RouteQuote}).
 *
 * BTC only. An Arkade address is the same string whether it is paid in BTC or
 * in an asset — the asset is named by the AMOUNT — so a request carrying one
 * drops this rail rather than paying its sats and dropping the asset, leaving
 * `ark-asset` to rank.
 */
export function arkRail(): PaymentRail {
    return {
        id: "ark",
        match: (req) => arkTarget(req.raw) !== undefined,
        available: (req) => assetsOf(req).length === 0,
        quote: async (req, ctx: RouterContext) => {
            const address = arkTarget(req.raw)!;
            // Also at quote time: `available()` is a router-level filter, and a
            // caller reaching a rail directly must get the same refusal.
            assertNoAssets("ark", req);
            const amt = resolveSendAmount("ark", req.raw, req.amount);
            return {
                railId: "ark",
                amount: amt,
                fee: 0,
                total: amt,
                send: async () =>
                    makeHandle("ark", async (emit) => {
                        const txid = await ctx.wallet.send({ address, amount: amt });
                        const result = { railId: "ark", txid };
                        emit({ status: "settled", result });
                        return result;
                    }),
            };
        },
    };
}
