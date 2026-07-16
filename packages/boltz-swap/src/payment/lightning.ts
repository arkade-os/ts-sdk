import type { PaymentRail, RouterContext } from "@arkade-os/sdk";
import { isLightningInvoice, makeHandle, BIP21, assertSendableAmount } from "@arkade-os/sdk";
import type { ArkadeSwaps } from "../arkade-swaps";
import { getInvoiceSatoshis } from "../utils/decoding";

/** The bolt11 invoice in `raw`: bare (minus any `lightning:` prefix) or the
 *  `lightning=` param of a unified BIP21 URI. */
function invoiceOf(raw: string): string | undefined {
    if (isLightningInvoice(raw)) return raw.replace(/^lightning:/i, "");
    try {
        const l = BIP21.parse(raw).params.lightning;
        return typeof l === "string" && isLightningInvoice(l)
            ? l.replace(/^lightning:/i, "")
            : undefined;
    } catch {
        return undefined;
    }
}

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
        match: (req) => invoiceOf(req.raw) !== undefined,
        available: async (req, ctx) => {
            if (ctx.swaps == null) return false;
            const invoice = invoiceOf(req.raw);
            if (!invoice) return false;
            const amt = invoiceSats(invoice);
            if (amt <= 0) return true; // amountless-invoice error deferred to quote()
            const { min, max } = await (ctx.swaps as ArkadeSwaps).getLimits(); // submarine
            return amt >= min && amt <= max;
        },
        quote: async (req, ctx: RouterContext) => {
            const invoice = invoiceOf(req.raw)!;
            // The bolt11 invoice carries the amount; reject amountless or
            // undecodable invoices instead of surfacing a `total: 0` quote.
            const amount = invoiceSats(invoice);
            assertSendableAmount("lightning", amount);
            return {
                railId: "lightning",
                amount,
                fee: 0,
                total: amount,
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
