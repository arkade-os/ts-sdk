import type { PaymentRail, RouterContext } from "../types";
import { isBtcAddress } from "../predicates";
import { resolveSendAmount } from "../amount";
import { makeHandle } from "../handle";
import { BIP21 } from "../../utils/bip21";
import { Ramps } from "../../wallet/ramps";

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
 * On-chain BTC send via collaborative exit — the Wallet-only on-chain path (no
 * swap). Matches a bare BTC address or the on-chain part of a unified BIP21 URI
 * and offboards VTXOs to the address via {@link Ramps.offboard}, which owns
 * fee-aware coin selection, dust-safe change, and settlement.
 */
export function onchainRail(): PaymentRail {
    return {
        id: "onchain",
        match: (raw) => btcTarget(raw) !== undefined,
        quote: async (raw, amount, ctx: RouterContext) => {
            const address = btcTarget(raw)!;
            // Reject missing/zero/fractional amounts up front: 0 sats would
            // silently settle nothing, and BigInt(amt) throws on non-integers.
            const amt = resolveSendAmount("onchain", raw, amount);
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
