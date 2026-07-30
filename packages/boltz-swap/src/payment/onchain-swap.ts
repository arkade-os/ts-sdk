import type { PaymentRail, RouterContext } from "@arkade-os/sdk";
import { btcTarget, makeHandle, resolveSendAmount, tryResolveSendAmount } from "@arkade-os/sdk";
import type { ArkadeSwaps } from "../arkade-swaps";
import type { ChainFeesResponse } from "../types";

/**
 * Reconstruct the ARK→BTC *source* amounts from the receiver amount this rail
 * knows, since Boltz prices and bounds the swap on what the user locks.
 *
 * `serverLock` is a lower bound; `userLock` inverts Boltz's percentage gross-up
 * (the fee is charged on the user-lock total, so divide by `1 - feeRate` —
 * adding `feeRate * serverLock` under-estimates near max) and is the upper bound.
 *
 * Returns `undefined` when the fee rate cannot gross up: only a rate in `[0, 1)`
 * works — at or above 100% the divisor turns zero or negative, and a negative
 * rate shrinks the estimate, either of which would silently produce a wrong
 * number. `NaN` fails the range test too.
 */
function grossUpUserLock(
    receiverAmount: number,
    fees: ChainFeesResponse,
): { serverLock: number; userLock: number } | undefined {
    const serverLock = receiverAmount + fees.minerFees.user.claim;
    const feeRate = fees.percentage / 100;
    if (!(feeRate >= 0 && feeRate < 1)) return undefined;
    const userLock = Math.ceil((serverLock + fees.minerFees.server) / (1 - feeRate));
    return { serverLock, userLock };
}

/**
 * On-chain BTC send via an Ark → BTC chain swap. Matches a bare BTC address or
 * the on-chain part of a unified BIP21 URI, and drives the full swap: create it
 * (`arkToBtc`), fund the Ark lockup (`Wallet.send`), then claim BTC
 * (`waitAndClaimBtc`) — mirroring the wallet's `payBtc`. Reads the `ArkadeSwaps`
 * client from `ctx.swaps`, so it is unavailable until swaps are configured.
 *
 * `available()` gates on the ARK→BTC limits. Boltz bounds the *source* (user-lock)
 * amount, which this receiver-exact rail doesn't know exactly, so the gate
 * brackets it from the fee components (see the body). An amount outside the
 * bracket drops the rail, and routing falls back to the `onchain` collaborative
 * exit automatically.
 *
 * Refund is the monitor's job, never the send path's (matching NArk, where the
 * `BoltzSwapProvider` poll-loop + sweeper own refunds). Construct `ArkadeSwaps`
 * with a `SwapManager` — the TS analogue — and `waitAndClaimBtc` delegates to it
 * for automatic cooperative/timelock refunds. Without one, a stranded lockup
 * surfaces on the handle's `failed` event: when its `error` is a `SwapError` with
 * `isRefundable === true` and a `pendingSwap`, the app calls
 * `swaps.refundArk(pendingSwap)` itself.
 */
export function onchainSwapRail(): PaymentRail {
    return {
        id: "onchain-swap",
        match: (req) => btcTarget(req.raw) !== undefined,
        available: async (req, ctx) => {
            if (ctx.swaps == null) return false;
            const amt = tryResolveSendAmount(req.raw, req.amount);
            if (amt === undefined) return true; // amount-required deferred to quote()
            const swaps = ctx.swaps as ArkadeSwaps;
            const [{ min, max }, fees] = await Promise.all([
                swaps.getLimits("ARK", "BTC"),
                swaps.getFees("ARK", "BTC"),
            ]);
            // Gate min on the lower bound (conservative) and max on the upper
            // bound; an amount in the ambiguous band self-heals to the `onchain`
            // collaborative exit.
            const bracket = grossUpUserLock(amt, fees);
            if (!bracket) return false;
            return bracket.serverLock >= min && bracket.userLock <= max;
        },
        quote: async (req, ctx: RouterContext) => {
            const address = btcTarget(req.raw)!;
            const amt = resolveSendAmount("onchain-swap", req.raw, req.amount);
            // Estimated from the same reconstruction available() brackets on, so
            // the gate and the quote cannot disagree. Boltz returns the
            // authoritative lockup amount from `arkToBtc` at send time.
            const fees = await (ctx.swaps as ArkadeSwaps).getFees("ARK", "BTC");
            const bracket = grossUpUserLock(amt, fees);
            if (!bracket) {
                throw new Error(
                    `onchain-swap: cannot quote at a ${fees.percentage}% fee rate ` +
                        `(expected a rate in [0, 100))`,
                );
            }
            return {
                railId: "onchain-swap",
                amount: amt,
                fee: bracket.userLock - amt,
                total: bracket.userLock,
                send: async () =>
                    makeHandle("onchain-swap", async (emit) => {
                        const swaps = ctx.swaps as ArkadeSwaps;
                        const { arkAddress, amountToPay, pendingSwap } = await swaps.arkToBtc({
                            btcAddress: address,
                            receiverLockAmount: amt,
                        });
                        // Fund the Ark lockup off-chain, then the swap settles to BTC.
                        // A rejection here is outside the refund contract below:
                        // nothing was locked, so Boltz just times the swap out —
                        // unless the send broadcast and only the response failed,
                        // in which case the lockup is stranded without a
                        // `pendingSwap` on the handle. Reconcile via
                        // `swaps.getPendingChainSwaps()`.
                        await ctx.wallet.send({ address: arkAddress, amount: amountToPay });
                        emit({ status: "sent" });
                        const { txid } = await swaps.waitAndClaimBtc(pendingSwap);
                        const result = { railId: "onchain-swap", txid, swapId: pendingSwap.id };
                        emit({ status: "settled", result });
                        return result;
                    }),
            };
        },
    };
}
