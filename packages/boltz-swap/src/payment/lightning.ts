import type { PaymentRail, RouterContext } from "@arkade-os/sdk";
import {
    assertNoAssets,
    assertSendableAmount,
    assetsOf,
    invoiceTarget,
    makeHandle,
} from "@arkade-os/sdk";
import type { ArkadeSwaps } from "../arkade-swaps";
import { getInvoiceSatoshis } from "../utils/decoding";

/** Amount encoded in a bolt11 invoice (sats), or 0 if amountless/undecodable. */
function invoiceSats(invoice: string): number {
    try {
        return getInvoiceSatoshis(invoice);
    } catch {
        return 0;
    }
}

/**
 * Lightning rail — pays a bolt11 invoice (or the `lightning=` param of a unified
 * BIP21 URI) through a Boltz submarine swap. Reads the `ArkadeSwaps` client from
 * `ctx.swaps` (wired by the boltz factory), so it is unavailable until swaps are
 * configured.
 */
export function lightningRail(): PaymentRail {
    return {
        id: "lightning",
        match: (req) => invoiceTarget(req.raw) !== undefined,
        available: async (req, ctx) => {
            // A bolt11 invoice is denominated in sats; an asset cannot ride it.
            if (assetsOf(req).length > 0) return false;
            if (ctx.swaps == null) return false;
            const invoice = invoiceTarget(req.raw);
            if (!invoice) return false;
            const amt = invoiceSats(invoice);
            if (amt <= 0) return true; // amountless-invoice error deferred to quote()
            const { min, max } = await (ctx.swaps as ArkadeSwaps).getLimits(); // submarine
            return amt >= min && amt <= max;
        },
        quote: async (req, ctx: RouterContext) => {
            const invoice = invoiceTarget(req.raw)!;
            assertNoAssets("lightning", req);
            // The bolt11 invoice carries the amount; reject amountless or
            // undecodable invoices instead of surfacing a `total: 0` quote.
            const amount = invoiceSats(invoice);
            assertSendableAmount("lightning", amount);
            // Estimated from Boltz's advertised submarine pricing: the percentage
            // is charged on the invoice amount, plus a flat lockup miner fee. The
            // payee always receives the invoice amount, so the fee sits on top.
            // Boltz returns the authoritative `expectedAmount` when the swap is
            // actually created inside `sendLightningPayment`.
            const { submarine } = await (ctx.swaps as ArkadeSwaps).getFees();
            const fee = Math.ceil((amount * submarine.percentage) / 100) + submarine.minerFees;
            return {
                railId: "lightning",
                amount,
                fee,
                total: amount + fee,
                send: async () =>
                    makeHandle("lightning", async (emit) => {
                        const swaps = ctx.swaps as ArkadeSwaps;
                        const { preimage, txid } = await swaps.sendLightningPayment({
                            invoice,
                            waitFor: "settled",
                        });
                        const result = { railId: "lightning", preimage, txid };
                        emit({ status: "settled", result });
                        return result;
                    }),
            };
        },
    };
}
