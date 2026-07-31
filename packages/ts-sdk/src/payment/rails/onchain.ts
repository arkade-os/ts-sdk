import type { PaymentRail, RouterContext } from "../types";
import { btcTarget } from "../targets";
import { resolveSendAmount } from "../amount";
import { makeHandle } from "../handle";
import { Ramps, offboardDestinationScript } from "../../wallet/ramps";
import { Estimator } from "../../arkfee";
import type { FeeInfo } from "../../providers/ark";
import { hex } from "@scure/base";

/** Iterations allowed when solving the gross-up fixpoint. A fee schedule charging
 *  less than one sat per extra sat converges in a handful of rounds; the cap only
 *  bounds a pathological program. */
const GROSS_UP_MAX_ROUNDS = 8;

/**
 * Solve `gross - fee(gross) = net` for the amount to hand {@link Ramps.offboard},
 * which *deducts* its output fee from whatever it is given.
 *
 * The fee program receives the amount (see `outputToArgs`), so it may itself be
 * amount-dependent — a single `net + fee(net)` under-shoots for any percentage
 * schedule. Iterating upward from `net` converges on the least fixpoint, and
 * because every intermediate value is an under-estimate a non-converging schedule
 * errs toward charging the sender too little rather than short-paying the
 * recipient.
 */
function grossUpOffboard(
    net: number,
    feeInfo: FeeInfo,
    script: string,
): { gross: number; fee: number } {
    const estimator = new Estimator(feeInfo?.intentFee ?? {});
    const feeAt = (amount: number): number =>
        estimator.evalOnchainOutput({ amount: BigInt(amount), script }).satoshis;

    let gross = net;
    for (let i = 0; i < GROSS_UP_MAX_ROUNDS; i++) {
        const next = net + feeAt(gross);
        if (next === gross) break;
        gross = next;
    }
    return { gross, fee: gross - net };
}

/**
 * On-chain BTC send via collaborative exit — the Wallet-only on-chain path (no
 * swap). Matches a bare BTC address or the on-chain part of a unified BIP21 URI
 * and offboards VTXOs to the address via {@link Ramps.offboard}, which owns
 * fee-aware coin selection, dust-safe change, and settlement.
 *
 * `offboard` deducts its fee from the amount it is handed, so the rail grosses
 * the amount up first: the recipient receives exactly `quote.amount`, matching
 * the receiver-exact semantics of every other rail (see {@link RouteQuote}).
 * `quote.total` is the offboard amount; the per-input intent fees `offboard`
 * shaves off the selected VTXOs are additional and depend on the selection, so
 * they are not part of the quote.
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
            // Priced here rather than in send() so the quote carries a real fee;
            // the same FeeInfo is reused at settlement, so the two cannot drift.
            const { fees } = await ctx.wallet.arkProvider.getInfo();
            const script = hex.encode(offboardDestinationScript(address));
            const { gross, fee } = grossUpOffboard(amt, fees, script);
            return {
                railId: "onchain",
                amount: amt,
                fee,
                total: gross,
                send: async () =>
                    makeHandle("onchain", async (emit) => {
                        const txid = await new Ramps(ctx.wallet).offboard(
                            address,
                            fees,
                            BigInt(gross),
                        );
                        const result = { railId: "onchain", txid };
                        emit({ status: "settled", result });
                        return result;
                    }),
            };
        },
    };
}
