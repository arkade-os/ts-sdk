/**
 * `lightning` — pay a BOLT11 invoice out of an Arkade balance, through the v2 swap client.
 *
 * The rail id stays `lightning` although the asset namespace is `bolt11`: it is a published registry
 * key that apps' `priority` and `disabled` lists name, so renaming would break their preferences.
 * The rail is only an adapter; persistence, settlement and solver selection live in the client.
 */
import type { PaymentRail, RouteQuote } from "@arkade-os/sdk";
import { assertNoAssets, assetsOf, invoiceTarget } from "@arkade-os/sdk";
import type { QuoteInput } from "../client/quote";
import {
    quoteMeta,
    railAvailable,
    receiverExact,
    swapHandle,
    type SwapRailClient,
} from "./swapRail";

export const LIGHTNING_RAIL = "lightning";

/**
 * The input for an invoice. A request amount is passed through, not dropped: an amount-bearing
 * invoice already pins one, so both is `AmountMismatch` **even when they agree** — the invoice is
 * what both sides settle against. Only an amountless invoice takes the request's amount.
 */
const inputFor = (invoice: string, amount: number | undefined): QuoteInput => ({
    to: invoice,
    ...(amount === undefined ? {} : { amount: BigInt(amount), amountOn: "take" }),
});

/** Register alongside core's rails; see {@link createSwapPaymentRouter} for the ranking. */
export function lightningRail(client: SwapRailClient): PaymentRail {
    return {
        id: LIGHTNING_RAIL,
        // classification only, so `match` is not a second gate on top of `available`
        match: (req) => invoiceTarget(req.raw) !== undefined,

        available: async (req) => {
            // A bolt11 invoice is denominated in sats; an asset cannot ride it.
            if (assetsOf(req).length > 0) return false;
            const invoice = invoiceTarget(req.raw);
            if (invoice === undefined) return false;
            // resolution, never a quote: quoting would disclose the invoice just to rank a route
            return railAvailable(client, inputFor(invoice, req.amount));
        },

        quote: async (req): Promise<RouteQuote> => {
            const invoice = invoiceTarget(req.raw);
            if (invoice === undefined) {
                throw new Error(`${LIGHTNING_RAIL}: the request carries no BOLT11 invoice`);
            }
            assertNoAssets(LIGHTNING_RAIL, req);
            const quote = await client.quote(inputFor(invoice, req.amount));
            // the fee is on the give leg for corridor routes, so give IS the receiver-exact total
            const amounts = receiverExact(LIGHTNING_RAIL, {
                amount: quote.take.amount,
                fee: quote.fee.amount,
                total: quote.give.amount,
            });
            return {
                railId: LIGHTNING_RAIL,
                ...amounts,
                meta: quoteMeta(quote),
                send: () => swapHandle(LIGHTNING_RAIL, client, quote),
            };
        },
    };
}
