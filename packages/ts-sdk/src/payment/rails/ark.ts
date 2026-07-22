import type { PaymentRail, RouterContext } from "../types";
import { isValidArkAddress } from "../predicates";
import { resolveSendAmount } from "../amount";
import { makeHandle } from "../handle";
import { BIP21 } from "../../utils/bip21";

/** The ark address in `raw`: bare, or the `ark=` param of a BIP21 URI. */
function arkTarget(raw: string): string | undefined {
    if (isValidArkAddress(raw)) return raw;
    try {
        const ark = BIP21.parse(raw).params.ark;
        return typeof ark === "string" && isValidArkAddress(ark) ? ark : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Off-chain Arkade send. Matches a bare ark address or the `ark=` param of a
 * unified BIP21 URI, and settles via `Wallet.send`.
 */
export function arkRail(): PaymentRail {
    return {
        id: "ark",
        match: (req) => arkTarget(req.raw) !== undefined,
        quote: async (req, ctx: RouterContext) => {
            const address = arkTarget(req.raw)!;
            const amt = resolveSendAmount("ark", req.raw, req.amount);
            return {
                railId: "ark",
                amount: amt,
                fee: 0,
                total: amt,
                send: async () =>
                    makeHandle("ark", async (emit) => {
                        const txid = await ctx.wallet.send({ address, amount: amt });
                        const result = { railId: "ark", txid };
                        emit({ status: "settled", result });
                        return result;
                    }),
            };
        },
    };
}
