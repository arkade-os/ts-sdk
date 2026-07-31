import type { PaymentRail, RouterContext } from "../types";
import { arkTarget } from "../targets";
import { resolveSendAmount } from "../amount";
import { makeHandle } from "../handle";

/**
 * Off-chain Arkade send. Matches a bare ark address or the `ark=` param of a
 * unified BIP21 URI, and settles via `Wallet.send`.
 *
 * The only rail that is receiver-exact for free: an off-chain send delivers the
 * full amount and carries no counterparty or on-chain fee, so `fee` is 0 and
 * `total` equals `amount` (see {@link RouteQuote}).
 */
export function arkRail(): PaymentRail {
    return {
        id: "ark",
        match: (req) => arkTarget(req.raw) !== undefined,
        quote: async (req, ctx: RouterContext) => {
            const address = arkTarget(req.raw)!;
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
