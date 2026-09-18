import type { PaymentRail, RouterContext } from "../types";
import { btcTarget } from "../targets";
import { assertNoAssets, assetsOf, resolveSendAmount, selectionOf } from "../amount";
import { makeHandle } from "../handle";
import { Ramps, offboardDestinationScript } from "../../wallet/ramps";
import { toOffchainInputFeeParams, type NormalizedExtendedVirtualCoin } from "../../wallet/vtxo";
import { Estimator } from "../../arkfee";
import type { FeeInfo } from "../../providers/ark";
import type { Wallet } from "../../index";
import { hex } from "@scure/base";

/** The canonical fee source for {@link onchainRail}: the operator's schedule, as
 *  the wallet already reads it. Keeps the one `arkProvider` reach in one place,
 *  so an app registering the rail itself need not know where fees live. */
export const walletFeeSource = (wallet: Wallet) => async (): Promise<FeeInfo> =>
    (await wallet.arkProvider.getInfo()).fees;

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

/** What spending each named input costs, priced with the program `offboard` settles on. */
function offchainInputFees(vtxos: readonly NormalizedExtendedVirtualCoin[], fees: FeeInfo): number {
    const estimator = new Estimator(fees?.intentFee ?? {});
    return vtxos.reduce(
        (total, vtxo) =>
            total + estimator.evalOffchainInput(toOffchainInputFeeParams(vtxo)).satoshis,
        0,
    );
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
 * A request naming `selectedVtxos` offboards exactly those — so the exit need not
 * sweep the whole off-chain balance into one change output — and only then does
 * the quote carry the per-input intent fees: unselected, the coins are chosen
 * later at settlement and there is nothing here to price.
 *
 * An explicit amount is mandatory. To sweep the full balance, call
 * `Ramps.offboard(address, feeInfo)` directly — the router has no amountless path.
 *
 * @param deps.feeInfo - Source of the operator's fee schedule. Required: a rail
 * that cannot price an offboard must not be constructible — a silently dropped
 * rail on the money path is worse than a wiring error at startup.
 */
export function onchainRail(deps: { feeInfo: () => Promise<FeeInfo> }): PaymentRail {
    // Types do not bind JavaScript callers, and the router does not re-rank after
    // a quote() throws — so refuse at wiring time rather than mid-payment.
    if (typeof deps?.feeInfo !== "function") {
        throw new Error("onchain rail: a feeInfo source is required");
    }
    return {
        id: "onchain",
        match: (req) => btcTarget(req.raw) !== undefined,
        // BTC only: an Arkade asset has no L1 representation to offboard to.
        available: (req) => assetsOf(req).length === 0,
        quote: async (req, ctx: RouterContext) => {
            assertNoAssets("onchain", req);
            const address = btcTarget(req.raw)!;
            // Reject missing/zero/fractional amounts up front: 0 sats would
            // silently settle nothing, and BigInt(amt) throws on non-integers.
            const amt = resolveSendAmount("onchain", req.raw, req.amount);
            // Priced here rather than in send() so the quote carries a real fee;
            // the same FeeInfo is reused at settlement, so the two cannot drift.
            const fees = await deps.feeInfo();
            const script = hex.encode(offboardDestinationScript(address));
            const { gross, fee } = grossUpOffboard(amt, fees, script);
            const selectedVtxos = selectionOf(req);
            const inputFee = selectedVtxos ? offchainInputFees(selectedVtxos, fees) : 0;
            return {
                railId: "onchain",
                amount: amt,
                fee: fee + inputFee,
                total: gross + inputFee,
                send: async () =>
                    makeHandle("onchain", async (emit) => {
                        const ramps = new Ramps(ctx.wallet);
                        // Omitted, not passed as undefined: the unselected call is unchanged.
                        const txid = selectedVtxos
                            ? await ramps.offboard(
                                  address,
                                  fees,
                                  BigInt(gross),
                                  undefined,
                                  selectedVtxos,
                              )
                            : await ramps.offboard(address, fees, BigInt(gross));
                        const result = { railId: "onchain", txid };
                        emit({ status: "settled", result });
                        return result;
                    }),
            };
        },
    };
}
