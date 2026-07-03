import type { PaymentRail, RouterContext } from "@arkade-os/sdk";
import { isBtcAddress, makeHandle, BIP21 } from "@arkade-os/sdk";
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
 */
export function onchainSwapRail(): PaymentRail {
    return {
        id: "onchain-swap",
        match: (raw) => btcTarget(raw) !== undefined,
        available: (ctx) => ctx.swaps != null,
        quote: async (raw, amount, ctx: RouterContext) => {
            const address = btcTarget(raw)!;
            const amt = amount ?? BIP21.amountSats(raw) ?? 0;
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
