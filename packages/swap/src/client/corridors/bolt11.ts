/**
 * The built-in BOLT11 decoder.
 *
 * Shipped rather than injected, with the override kept: §4 promises the caller
 * passes a bolt11 string and the corridor decodes it, which is false for every
 * integrator under a `decodeInvoice` callback, and NArk decides it the same way
 * — `BOLT11PaymentRequest.Parse(invoice, network)` is a library decode. Core
 * still carries no bolt11 dependency; this one belongs to the swap package.
 *
 * What it produces is v1's {@link InvoiceFacts}, unchanged, because that is the
 * shape `CorridorOverrides.lightning.decode` is declared in and the shape
 * `verifyReceiveInvoice` already reads. Two conversions the deleted
 * `boltz-swap` decoder made are corrected here, and a third is left to the
 * module boundary:
 *
 * - **Expiry is absolute.** The library's `expiry` getter is the `x` tag's
 *   RELATIVE seconds (its own absolute getter is overwritten by the tag loop
 *   right after it is defined), so the timestamp is added here and BOLT11's
 *   3600-second default applies when the tag is absent.
 * - **Millisats convert through `bigint`.** `Number(millisats) / 1000` loses
 *   precision past 2^53; the division happens in `bigint` and narrows after.
 * - **An amountless invoice reports `0`**, which is how v1 spells it
 *   (`verifyReceiveInvoice` gates on `amountSats <= 0`). Turning that into
 *   `amount: undefined` on the instrument, and refusing it on a send route, is
 *   the lightning module's job.
 *
 * A missing payment hash is a throw and not a `?? ""`: the `p` tag is required
 * by BOLT11, `Hex` is a bare alias, and an empty hash would typecheck onto the
 * invoice instrument and then be compared byte-for-byte downstream.
 */
import bolt11 from "light-bolt11-decoder";
import type { InvoiceFacts } from "../../rfq";

/** BOLT11's default expiry when an invoice carries no `x` tag. */
export const DEFAULT_INVOICE_EXPIRY_SECONDS = 3600;

/**
 * One section lookup, over a widened view of the decoder's output.
 *
 * `light-bolt11-decoder` types `sections` as a union whose arms disagree about
 * `value`, and it emits tags the union does not name at all (`description_hash`
 * is the known one). One widening at the boundary beats a cast per lookup.
 */
const valueOf = (decoded: { sections: readonly unknown[] }, name: string): unknown =>
    (decoded.sections as readonly { name: string; value?: unknown }[]).find(
        (section) => section.name === name,
    )?.value;

/** `sha256(P)` as {@link InvoiceFacts} declares it: 64 lowercase hex chars. */
const PAYMENT_HASH = /^[0-9a-f]{64}$/;

/**
 * Decode a BOLT11 invoice into the facts the corridor needs.
 *
 * Signature-blind, like the library: nothing here proves the invoice was issued
 * by whoever offered it. What it does prove is that the payment hash the
 * corridor will compare against is the one the payer would pay to.
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

    // Absent for an amountless invoice, which BOLT11 permits and which lets a
    // payer pay anything. `0` is how v1 spells that, and every gate above this
    // one reads `<= 0` rather than a nullish check.
    const millisats = valueOf(decoded, "amount");
    const amountSats =
        typeof millisats === "string" ? Number(BigInt(millisats) / 1000n) : /* amountless */ 0;

    return { raw: invoice, paymentHash, amountSats, expiresAt };
};
