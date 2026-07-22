import type { PaymentRail, RouterContext } from "@arkade-os/sdk";
import {
    isBtcAddress,
    makeHandle,
    BIP21,
    resolveSendAmount,
    tryResolveSendAmount,
} from "@arkade-os/sdk";
import type { ArkadeSwaps } from "../arkade-swaps";

/** The on-chain BTC address in `raw`: bare, or the address of a BIP21 URI. */
function btcTarget(raw: string): string | undefined {
    if (isBtcAddress(raw)) return raw;
    try {
        const addr = BIP21.parse(raw).params.address;
        return typeof addr === "string" && isBtcAddress(addr) ? addr : undefined;
    } catch {
        return undefined;
    }
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
            // Boltz enforces the ARK→BTC limits on the *source* (user-lock)
            // amount, not the receiver amount we know. Bracket the source:
            // `serverLock` is a lower bound, and `userLock` — Boltz's percentage
            // gross-up inverted (the fee is charged on the user-lock total, so
            // divide by (1 - feeRate); adding feeRate * serverLock under-estimates
            // near max) — is the upper bound. Gate min on the lower bound
            // (conservative) and max on the upper bound; an amount in the
            // ambiguous band self-heals to the `onchain` collaborative exit.
            const serverLockAmount = amt + fees.minerFees.user.claim;
            const feeRate = fees.percentage / 100;
            const userLockAmount = Math.ceil(
                (serverLockAmount + fees.minerFees.server) / (1 - feeRate),
            );
            return serverLockAmount >= min && userLockAmount <= max;
        },
        quote: async (req, ctx: RouterContext) => {
            const address = btcTarget(req.raw)!;
            const amt = resolveSendAmount("onchain-swap", req.raw, req.amount);
            return {
                railId: "onchain-swap",
                amount: amt,
                fee: 0,
                total: amt,
                send: async () =>
                    makeHandle("onchain-swap", async (emit) => {
                        const swaps = ctx.swaps as ArkadeSwaps;
                        const { arkAddress, amountToPay, pendingSwap } = await swaps.arkToBtc({
                            btcAddress: address,
                            receiverLockAmount: amt,
                        });
                        // Fund the Ark lockup off-chain, then the swap settles to BTC.
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
