/**
 * The built-in BOLT11 decoder, producing v1's {@link InvoiceFacts}. Shipped rather than injected
 * (NArk decides it the same way); `CorridorOverrides.lightning.decode` still overrides it.
 *
 * - **Expiry is absolute.** The library's `expiry` is the `x` tag's RELATIVE seconds, so the
 *   timestamp is added here, with BOLT11's 3600 s default when the tag is absent.
 * - **Millisats convert through `bigint`**: `Number(millisats) / 1000` loses precision past 2^53.
 * - **An amountless invoice reports `0`**, v1's spelling (gates read `<= 0`, not nullish).
 *
 * A missing payment hash throws rather than `?? ""`: an empty hash would typecheck onto the
 * instrument and then be compared byte-for-byte downstream.
 */
import bolt11 from "light-bolt11-decoder";
import type { InvoiceFacts } from "../../rfq";
import { PAYMENT_HASH } from "./lightning";

/** BOLT11's default expiry when an invoice carries no `x` tag. */
export const DEFAULT_INVOICE_EXPIRY_SECONDS = 3600;

/**
 * One section lookup over a widened view: the decoder's `sections` union disagrees about `value`
 * and omits tags it emits (`description_hash`).
 */
const valueOf = (decoded: { sections: readonly unknown[] }, name: string): unknown =>
    (decoded.sections as readonly { name: string; value?: unknown }[]).find(
        (section) => section.name === name,
    )?.value;

/**
 * Decode a BOLT11 invoice into the facts the corridor needs.
 *
 * Signature-blind, like the library: it does not prove who issued the invoice, only that the
 * payment hash compared downstream is the one the payer would pay to.
 *
 * @throws when the string is not a decodable BOLT11 invoice, or decodes without
 *   the timestamp or payment hash BOLT11 requires.
 */
export const decodeBolt11 = (invoice: string): InvoiceFacts => {
    const decoded = bolt11.decode(invoice);

    const timestamp = valueOf(decoded, "timestamp");
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
        throw new Error("bolt11 invoice carries no timestamp");
    }
    const expiry = valueOf(decoded, "expiry");
    const expiresAt =
        timestamp + (typeof expiry === "number" ? expiry : DEFAULT_INVOICE_EXPIRY_SECONDS);

    const paymentHash = valueOf(decoded, "payment_hash");
    if (typeof paymentHash !== "string" || !PAYMENT_HASH.test(paymentHash)) {
        throw new Error("bolt11 invoice carries no payment hash");
    }

    const millisats = valueOf(decoded, "amount");
    const amountSats =
        typeof millisats === "string" ? Number(BigInt(millisats) / 1000n) : /* amountless */ 0;

    return { raw: invoice, paymentHash, amountSats, expiresAt };
};
