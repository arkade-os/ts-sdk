import type { PaymentRail, RouterContext } from "../types";
import { btcTarget } from "../targets";
import { assertNoAssets, assetsOf, resolveSendAmount, selectionOf } from "../amount";
import { makeHandle } from "../handle";
import { Ramps, changeAfterOutputFee, offboardDestinationScript } from "../../wallet/ramps";
import { toOffchainInputFeeParams, type NormalizedExtendedVirtualCoin } from "../../wallet/vtxo";
import { Estimator } from "../../arkfee";
import type { FeeInfo } from "../../providers/ark";
import type { Wallet } from "../../index";
import { ArkAddress } from "../../script/address";
import { hex } from "@scure/base";

/** The canonical fee source for {@link onchainRail}: the operator's schedule, as
 *  the wallet already reads it. Keeps the one `arkProvider` reach in one place,
 *  so an app registering the rail itself need not know where fees live. */
export const walletFeeSource = (wallet: Wallet) => async (): Promise<FeeInfo> =>
    (await wallet.arkProvider.getInfo()).fees;

/** What spending each named input costs, priced with the program `offboard` settles on. */
function offchainInputFees(vtxos: readonly NormalizedExtendedVirtualCoin[], fees: FeeInfo): number {
    const estimator = new Estimator(fees?.intentFee ?? {});
    return vtxos.reduce(
        (total, vtxo) =>
            total + estimator.evalOffchainInput(toOffchainInputFeeParams(vtxo)).satoshis,
        0,
    );
}

/** What the change output costs on its own size, for a named input set. */
async function changeOutputFee(
    wallet: RouterContext["wallet"],
    inputs: readonly NormalizedExtendedVirtualCoin[],
    needed: bigint,
    fees: FeeInfo,
): Promise<bigint> {
    const estimator = new Estimator(fees?.intentFee ?? {});
    const net = inputs.reduce(
        (total, vtxo) =>
            total +
            BigInt(vtxo.value) -
            BigInt(estimator.evalOffchainInput(toOffchainInputFeeParams(vtxo)).satoshis),
        0n,
    );
    const script = hex.encode(ArkAddress.decode(await wallet.getAddress()).pkScript);
    return changeAfterOutputFee(net - needed, (amount) =>
        BigInt(estimator.evalOffchainOutput({ amount, script }).satoshis),
    ).fee;
}

/**
 * On-chain BTC send via collaborative exit — the Wallet-only on-chain path (no
 * swap). Matches a bare BTC address or the on-chain part of a unified BIP21 URI
 * and offboards VTXOs to the address via {@link Ramps.offboard}, which owns
 * fee-aware coin selection, dust-safe change, and settlement.
 *
 * The exit fee is priced on the DESTINATION output — the one arkd charges for —
 * and met from the balance, so the recipient receives exactly `quote.amount`
 * (see {@link RouteQuote}). {@link Ramps.offboardExact} carries that; the
 * gross-up this rail used to do could only approximate it.
 *
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
            // The output arkd charges for, not what is sourced to pay for it.
            const exitFee = Number(
                new Estimator(fees?.intentFee ?? {}).evalOnchainOutput({
                    amount: BigInt(amt),
                    script,
                }).satoshis,
            );
            const selectedVtxos = selectionOf(req);
            const inputFee = selectedVtxos ? offchainInputFees(selectedVtxos, fees) : 0;
            // Named inputs make the change knowable, and it pays its own fee.
            const changeFee = selectedVtxos
                ? await changeOutputFee(
                      ctx.wallet,
                      selectedVtxos,
                      BigInt(amt) + BigInt(exitFee),
                      fees,
                  )
                : 0n;
            return {
                railId: "onchain",
                amount: amt,
                fee: exitFee + inputFee + Number(changeFee),
                total: amt + exitFee + inputFee + Number(changeFee),
                send: async () =>
                    makeHandle("onchain", async (emit) => {
                        const ramps = new Ramps(ctx.wallet);
                        const txid = await ramps.offboardExact({
                            destinationAddress: address,
                            feeInfo: fees,
                            amount: BigInt(amt),
                            // Omitted, not undefined: an empty set covers nothing.
                            ...(selectedVtxos ? { vtxos: selectedVtxos } : {}),
                        });
                        const result = { railId: "onchain", txid };
                        emit({ status: "settled", result });
                        return result;
                    }),
            };
        },
    };
}
