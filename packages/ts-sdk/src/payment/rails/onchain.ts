import type { PaymentRail, RouterContext } from "../types";
import { btcTarget } from "../targets";
import { resolveSendAmount } from "../amount";
import { makeHandle } from "../handle";
import { Ramps } from "../../wallet/ramps";

/**
 * On-chain BTC send via collaborative exit — the Wallet-only on-chain path (no
 * swap). Matches a bare BTC address or the on-chain part of a unified BIP21 URI
 * and offboards VTXOs to the address via {@link Ramps.offboard}, which owns
 * fee-aware coin selection, dust-safe change, and settlement.
 *
 * An explicit amount is mandatory. To sweep the full balance, call
 * `Ramps.offboard(address, feeInfo)` directly — the router has no amountless path.
 */
export function onchainRail(): PaymentRail {
    return {
        id: "onchain",
        match: (req) => btcTarget(req.raw) !== undefined,
        quote: async (req, ctx: RouterContext) => {
            const address = btcTarget(req.raw)!;
            // Reject missing/zero/fractional amounts up front: 0 sats would
            // silently settle nothing, and BigInt(amt) throws on non-integers.
            const amt = resolveSendAmount("onchain", req.raw, req.amount);
            return {
                railId: "onchain",
                amount: amt,
                // Provisional: Ramps.offboard deducts the real intent + network
                // fees from the amount at settlement time.
                fee: 0,
                total: amt,
                send: async () =>
                    makeHandle("onchain", async (emit) => {
                        const { fees } = await ctx.wallet.arkProvider.getInfo();
                        const txid = await new Ramps(ctx.wallet).offboard(
                            address,
                            fees,
                            BigInt(amt),
                        );
                        const result = { railId: "onchain", txid };
                        emit({ status: "settled", result });
                        return result;
                    }),
            };
        },
    };
}
