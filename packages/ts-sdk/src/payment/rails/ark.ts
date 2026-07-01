import type { PaymentRail, RouterContext } from "../types";
import { isArkAddress } from "../predicates";
import { makeHandle } from "../handle";
import { BIP21 } from "../../utils/bip21";

/** The ark address in `raw`: bare, or the `ark=` param of a BIP21 URI. */
function arkTarget(raw: string): string | undefined {
    if (isArkAddress(raw)) return raw;
    try {
        const ark = BIP21.parse(raw).params.ark;
        return typeof ark === "string" && isArkAddress(ark) ? ark : undefined;
    } catch {
        return undefined;
    }
}

/** Integer-sats amount encoded in a BIP21 URI (`amount=` is BTC), if any. */
function encodedAmountSats(raw: string): number | undefined {
    try {
        const btc = BIP21.parse(raw).params.amount;
        return typeof btc === "number" ? Math.round(btc * 1e8) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Off-chain Arkade send. Matches a bare ark address or the `ark=` param of a
 * unified BIP21 URI, and settles via `Wallet.sendBitcoin`.
 */
export function arkRail(): PaymentRail {
    return {
        id: "ark",
        match: (raw) => arkTarget(raw) !== undefined,
        quote: async (raw, amount, ctx: RouterContext) => {
            const address = arkTarget(raw)!;
            const amt = amount ?? encodedAmountSats(raw) ?? 0;
            return {
                railId: "ark",
                amount: amt,
                fee: 0,
                total: amt,
                send: async () =>
                    makeHandle("ark", async (emit) => {
                        const txid = await ctx.wallet.sendBitcoin({ address, amount: amt });
                        const result = { railId: "ark", txid };
                        emit({ status: "settled", result });
                        return result;
                    }),
            };
        },
    };
}
