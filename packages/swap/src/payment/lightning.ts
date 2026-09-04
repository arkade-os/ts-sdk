/**
 * `lightning` — pay a BOLT11 invoice out of an Arkade balance, through the v2
 * swap client.
 *
 * The rail id is a registry key with published history: the factory deleted
 * with `packages/boltz-swap` registered `"lightning"`, and a key is what an
 * app's `priority` array and `disabled` list name. It therefore stays
 * `lightning` even though Q12 renamed the lightning *asset* namespace to
 * `bolt11` — the divergence between a registry key and an asset vocabulary is
 * recorded here, not resolved by a rename that would break every consumer's
 * preferences.
 *
 * The whole rail is an adapter. The invoice fixes the amount, the client
 * verifies and prices the route, `accept()` persists before it funds, and the
 * drive owns everything after — so there is no `persist`, no `awaitSettlement`
 * and no solver selection to configure here.
 */
import type { PaymentRail, RouteQuote } from "@arkade-os/sdk";
import { invoiceTarget } from "@arkade-os/sdk";
import type { QuoteInput } from "../client/quote";
import { railAvailable, receiverExact, swapHandle, type SwapRailClient } from "./swapRail";

export const LIGHTNING_RAIL = "lightning";

/**
 * The input for an invoice.
 *
 * A request amount is passed through rather than dropped, and the v2 rule then
 * applies: exactly one amount may be pinned, and an amount-bearing invoice pins
 * one by existing. Passing both is `AmountMismatch` **even when they agree** —
 * "they agreed this time" is not a rule anyone can rely on, and the invoice is
 * what both sides settle against. An amountless invoice is where the request's
 * own amount is the only pin there is.
 */
const inputFor = (invoice: string, amount: number | undefined): QuoteInput => ({
    to: invoice,
    ...(amount === undefined ? {} : { amount: BigInt(amount), amountOn: "take" }),
});

/**
 * Register alongside core's rails. The deleted factory's ranking was
 * `["ark", "lightning", "onchain-swap", "onchain"]`; see
 * {@link createSwapPaymentRouter}.
 */
export function lightningRail(client: SwapRailClient): PaymentRail {
    return {
        id: LIGHTNING_RAIL,
        // Amount-blind and non-throwing: classification only, which is what
        // keeps `match` from being a second gate on top of `available`.
        match: (req) => invoiceTarget(req.raw) !== undefined,

        available: async (req) => {
            const invoice = invoiceTarget(req.raw);
            if (invoice === undefined) return false;
            // Resolution, never a quote: quoting here would disclose the
            // invoice to a solver merely to rank a route the caller may not
            // take.
            return railAvailable(client, inputFor(invoice, req.amount));
        },

        quote: async (req): Promise<RouteQuote> => {
            const invoice = invoiceTarget(req.raw);
            if (invoice === undefined) {
                throw new Error(`${LIGHTNING_RAIL}: the request carries no BOLT11 invoice`);
            }
            const quote = await client.quote(inputFor(invoice, req.amount));
            // The payee is paid the invoice, and the spread sits on top: on a
            // corridor route the fee is denominated on the give leg, so the
            // give amount IS the receiver-exact total.
            const amounts = receiverExact(LIGHTNING_RAIL, {
                amount: quote.take.amount,
                fee: quote.fee.amount,
                total: quote.give.amount,
            });
            return {
                railId: LIGHTNING_RAIL,
                ...amounts,
                meta: {
                    quoteId: quote.id,
                    // A `RouteQuote` carries no expiry of its own, so a held one
                    // can outlive the terms behind it. This is where a caller
                    // can see that; `send()` refuses with `QuoteExpired` rather
                    // than silently re-quoting.
                    expiresAt: quote.expiresAt,
                    ...(quote.refundLocktime === undefined
                        ? {}
                        : { refundLocktime: quote.refundLocktime }),
                    ...(quote.solver === undefined ? {} : { solver: quote.solver }),
                    ...(quote.lock === undefined ? {} : { paymentHash: quote.lock.hash }),
                    market: quote.market.key,
                },
                send: () => swapHandle(LIGHTNING_RAIL, client, quote),
            };
        },
    };
}
