/**
 * `onchain-swap` — pay an L1 address out of an Arkade balance through a solver, via the v2 swap
 * client. Ranked ahead of core's `onchain` rail with both registered: an out-of-range request
 * drops this rail at `available()` and `onchain` wins with no error. The id is what an app's
 * `priority` array names, so it must stay `"onchain-swap"`.
 *
 * **The claim fee.** The trader claims the solver's L1 HTLC itself and the fee comes out of the
 * output (`payout = utxo.amount - fee`), which the swap quote knows nothing about. So the rail
 * grosses the take leg up by the estimated claim fee and reports it inside `fee`; quoting the
 * spread alone would understate the cost and win rankings it should lose. A payout under
 * {@link ONCHAIN_DUST_SATS} is refused before a lockup exists, not after one is funded.
 */
import type { PaymentRail, RouteQuote } from "@arkade-os/sdk";
import {
    assertNoAssets,
    assetsOf,
    btcTarget,
    resolveSendAmount,
    tryResolveSendAmount,
} from "@arkade-os/sdk";
import { ONCHAIN_CLAIM_VSIZE, ONCHAIN_DUST_SATS } from "../onchainHtlc";
import type { QuoteInput } from "../client/quote";
import {
    quoteMeta,
    railAvailable,
    receiverExact,
    swapHandle,
    type SwapRailClient,
} from "./swapRail";

export const ONCHAIN_SWAP_RAIL = "onchain-swap";

export interface OnchainSwapRailDeps {
    /**
     * Sat/vB the trader's L1 claim will be built at — the rate the corridor's own `claim` dep
     * uses. Required: without it the rail either quotes a fee it does not charge or short-pays
     * the recipient.
     */
    readonly claimFeeRateSatVb: number;
    /** vsize the claim is priced at. Defaults to {@link ONCHAIN_CLAIM_VSIZE}. */
    readonly claimVsize?: number;
}

/** What the trader's L1 claim will cost, rounded up as the builder rounds it. */
export const claimFeeSats = (deps: OnchainSwapRailDeps): bigint =>
    BigInt(Math.ceil((deps.claimVsize ?? ONCHAIN_CLAIM_VSIZE) * deps.claimFeeRateSatVb));

/**
 * Register alongside core's rails, ranked ahead of `onchain`:
 * `["ark", "lightning", "onchain-swap", "onchain"]`. See
 * {@link createSwapPaymentRouter}.
 */
export function onchainSwapRail(client: SwapRailClient, deps: OnchainSwapRailDeps): PaymentRail {
    if (!Number.isFinite(deps.claimFeeRateSatVb) || deps.claimFeeRateSatVb <= 0) {
        throw new Error(
            `${ONCHAIN_SWAP_RAIL}: claimFeeRateSatVb must be positive, got ${deps.claimFeeRateSatVb}`,
        );
    }
    const claimFee = claimFeeSats(deps);

    /** The solver's obligation: what the recipient gets, plus what the claim costs. */
    const inputFor = (address: string, amount: number): QuoteInput => ({
        to: address,
        amount: BigInt(amount) + claimFee,
        amountOn: "take",
    });

    return {
        id: ONCHAIN_SWAP_RAIL,
        match: (req) => btcTarget(req.raw) !== undefined,

        available: async (req) => {
            // BTC only: an Arkade asset has no L1 form, and paying the carrier sats delivers none.
            if (assetsOf(req).length > 0) return false;
            const address = btcTarget(req.raw);
            if (address === undefined) return false;
            // Amountless defers to `quote()`, where "an amount is required" belongs.
            const amount = tryResolveSendAmount(req.raw, req.amount);
            if (amount === undefined) return false;
            // The payout IS the requested amount, so sub-dust is out of range here.
            if (BigInt(amount) < ONCHAIN_DUST_SATS) return false;
            // The corridor validates the address's network, so a `tb1…` on mainnet drops here.
            return railAvailable(client, inputFor(address, amount));
        },

        quote: async (req): Promise<RouteQuote> => {
            const address = btcTarget(req.raw);
            if (address === undefined) {
                throw new Error(`${ONCHAIN_SWAP_RAIL}: the request carries no bitcoin address`);
            }
            assertNoAssets(ONCHAIN_SWAP_RAIL, req);
            const amount = resolveSendAmount(ONCHAIN_SWAP_RAIL, req.raw, req.amount);
            const quote = await client.quote(inputFor(address, amount));
            const payout = quote.take.amount - claimFee;
            // `buildHtlcClaim` applies the same floor, but only at claim time with the lockup
            // funded, where the only way out is a refund. Also catches a negative payout.
            if (payout < ONCHAIN_DUST_SATS) {
                throw new Error(
                    `${ONCHAIN_SWAP_RAIL}: the solver's take leg of ${quote.take.amount} sat ` +
                        `leaves ${payout} sat after the ${claimFee} sat claim fee, under the ` +
                        `${ONCHAIN_DUST_SATS} sat dust limit the claim is built against`,
                );
            }
            const amounts = receiverExact(ONCHAIN_SWAP_RAIL, {
                amount: payout,
                // The solver's spread plus the claim the trader pays out of the payout.
                fee: quote.fee.amount + claimFee,
                total: quote.give.amount,
            });
            return {
                railId: ONCHAIN_SWAP_RAIL,
                ...amounts,
                meta: {
                    ...quoteMeta(quote),
                    claimFeeSats: Number(claimFee),
                    // What the solver locks on L1, before the claim's fee.
                    htlcAmountSats: Number(quote.take.amount),
                },
                send: () => swapHandle(ONCHAIN_SWAP_RAIL, client, quote),
            };
        },
    };
}
