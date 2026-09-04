/**
 * `onchain-swap` — pay an L1 address out of an Arkade balance through a solver,
 * via the v2 swap client.
 *
 * Registered alongside core's `onchain` rail (the collaborative exit) and
 * ranked ahead of it, with both left registered: the default is a *preference*,
 * not a restriction. The preference self-heals by amount — an out-of-range
 * request drops this rail at `available()` and `onchain` wins with no error.
 *
 * The id is the deleted factory's published registry key, `"onchain-swap"`,
 * kept for the reason the `lightning` rail keeps its own: a rail id is what an
 * app's `priority` array names.
 *
 * **The claim fee is this rail's whole subtlety.** On `arkade -> onchain` the
 * trader claims the solver's L1 HTLC itself, and that claim's fee comes out of
 * the HTLC output — `payout = utxo.amount - fee`. So the sats the recipient
 * actually receives are less than the sats the solver locks, by an amount the
 * swap quote knows nothing about. A rail that quoted the solver's spread alone
 * would be reporting a fee it does not charge, and would win a ranking against
 * the collaborative exit that it should lose.
 *
 * This rail therefore takes a claim fee-rate policy at construction and grosses
 * the swap up by the estimate: it asks the solver for `amount + claimFee` on the
 * take leg, so what lands after the claim is the `amount` the caller asked for,
 * and it reports the estimate inside `fee` where a ranking can see it. A fee
 * rate is environment-specific and is nobody's to default — the same reason
 * `CorridorOverrides.onchain.claim` has no default.
 */
import type { PaymentRail, RouteQuote } from "@arkade-os/sdk";
import { btcTarget, resolveSendAmount, tryResolveSendAmount } from "@arkade-os/sdk";
import { ONCHAIN_CLAIM_VSIZE } from "../onchainHtlc";
import type { QuoteInput } from "../client/quote";
import { railAvailable, receiverExact, swapHandle, type SwapRailClient } from "./swapRail";

export const ONCHAIN_SWAP_RAIL = "onchain-swap";

export interface OnchainSwapRailDeps {
    /**
     * Sat/vB the trader's L1 claim will be built at — the rate the corridor's
     * own `claim` dep will use.
     *
     * No default, and the rail refuses to exist without it: the fee comes out
     * of the recipient's payout, so a rail with no rate either quotes a fee it
     * does not charge or short-pays the recipient. Neither is a default.
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
            const address = btcTarget(req.raw);
            if (address === undefined) return false;
            // An amountless request defers to `quote()`, which is where "an
            // amount is required" belongs: nothing can be bounds-checked
            // without one, so the rail cannot claim to fit.
            const amount = tryResolveSendAmount(req.raw, req.amount);
            if (amount === undefined) return false;
            // Resolution, never a quote — and the address is validated against
            // the wallet's network by the corridor that claims it, so a `tb1…`
            // on mainnet drops this rail here rather than at settlement.
            return railAvailable(client, inputFor(address, amount));
        },

        quote: async (req): Promise<RouteQuote> => {
            const address = btcTarget(req.raw);
            if (address === undefined) {
                throw new Error(`${ONCHAIN_SWAP_RAIL}: the request carries no bitcoin address`);
            }
            const amount = resolveSendAmount(ONCHAIN_SWAP_RAIL, req.raw, req.amount);
            const quote = await client.quote(inputFor(address, amount));
            const amounts = receiverExact(ONCHAIN_SWAP_RAIL, {
                // What lands at the address, which is the HTLC the solver locks
                // minus the claim this wallet will broadcast to take it.
                amount: quote.take.amount - claimFee,
                // Both halves of the cost, inside one number: the solver's
                // spread, and the claim the trader pays for out of the payout.
                fee: quote.fee.amount + claimFee,
                total: quote.give.amount,
            });
            return {
                railId: ONCHAIN_SWAP_RAIL,
                ...amounts,
                meta: {
                    quoteId: quote.id,
                    expiresAt: quote.expiresAt,
                    ...(quote.refundLocktime === undefined
                        ? {}
                        : { refundLocktime: quote.refundLocktime }),
                    ...(quote.solver === undefined ? {} : { solver: quote.solver }),
                    ...(quote.lock === undefined ? {} : { paymentHash: quote.lock.hash }),
                    market: quote.market.key,
                    /** The estimate folded into `fee`, so a caller can see it. */
                    claimFeeSats: Number(claimFee),
                    /** What the solver locks on L1, before the claim's fee. */
                    htlcAmountSats: Number(quote.take.amount),
                },
                send: () => swapHandle(ONCHAIN_SWAP_RAIL, client, quote),
            };
        },
    };
}
