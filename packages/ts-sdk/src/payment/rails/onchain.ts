import type { PaymentRail, RouterContext } from "../types";
import { isBtcAddress } from "../predicates";
import { makeHandle } from "../handle";
import { BIP21 } from "../../utils/bip21";

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
 * On-chain BTC send via collaborative exit — the Wallet-only on-chain path (no
 * swap). Matches a bare BTC address or the on-chain part of a unified BIP21
 * URI, selects soonest-expiring VTXOs to cover the amount, and `Wallet.settle`s
 * them to the address with change back to the wallet.
 */
export function onchainRail(): PaymentRail {
    return {
        id: "onchain",
        match: (raw) => btcTarget(raw) !== undefined,
        quote: async (raw, amount, ctx: RouterContext) => {
            const address = btcTarget(raw)!;
            const amt = amount ?? encodedAmountSats(raw) ?? 0;
            return {
                railId: "onchain",
                amount: amt,
                fee: 0,
                total: amt,
                send: async () =>
                    makeHandle("onchain", async (emit) => {
                        const txid = await collaborativeExit(ctx.wallet, address, amt);
                        const result = { railId: "onchain", txid };
                        emit({ status: "settled", result });
                        return result;
                    }),
            };
        },
    };
}

/**
 * Select soonest-expiring VTXOs covering `amount` and settle them to `address`,
 * returning change to the wallet's offchain address. Mirrors the wallet app's
 * hand-rolled collaborative exit (`lib/asp.ts`), the dedup target of this rail.
 */
async function collaborativeExit(
    wallet: RouterContext["wallet"],
    address: string,
    amount: number,
): Promise<string> {
    const vtxos = await wallet.getVtxos();
    const sorted = [...vtxos].sort(
        (a, b) => (a.virtualStatus.batchExpiry ?? 0) - (b.virtualStatus.batchExpiry ?? 0),
    );

    const selected: typeof sorted = [];
    let selectedAmount = 0;
    for (const v of sorted) {
        if (selectedAmount >= amount) break;
        selected.push(v);
        selectedAmount += v.value;
    }
    if (selectedAmount < amount) {
        throw new Error("Insufficient funds for collaborative exit");
    }

    const outputs = [{ address, amount: BigInt(amount) }];
    const change = selectedAmount - amount;
    if (change > 0) {
        outputs.push({ address: await wallet.getAddress(), amount: BigInt(change) });
    }
    outputs.reverse(); // exit-with-assets ordering (mirrors the wallet app)

    return wallet.settle({ inputs: selected, outputs });
}
