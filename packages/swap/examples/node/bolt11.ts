/**
 * A BOLT11 decode, deliberately living in the example rather than in the
 * package: `@arkade-os/swap` takes invoice FACTS, not a decoder, so whatever
 * decoder a wallet already ships serves. This one wraps
 * `light-bolt11-decoder`, the same decoder the Boltz plugin uses.
 */
import bolt11 from "light-bolt11-decoder";

import type { InvoiceFacts } from "../../src/index.js";

export const invoiceFacts = (raw: string): InvoiceFacts => {
    const decoded = bolt11.decode(raw);
    const sections = decoded.sections as Array<{ name: string; value?: unknown }>;
    const value = (name: string): unknown => sections.find((s) => s.name === name)?.value;

    const millisats = BigInt((value("amount") as string | undefined) ?? "0");
    if (millisats === 0n) {
        // the lightning-send profile is exact-out: the invoice fixes the amount
        throw new Error("amountless invoice — the swap has no amount to quote");
    }
    const paymentHash = value("payment_hash") as string | undefined;
    if (!paymentHash) throw new Error("invoice carries no payment hash");

    return {
        raw,
        paymentHash,
        amountSats: Number(millisats / 1000n),
        expiresAt: Number(value("timestamp") ?? 0) + (decoded.expiry ?? 3600),
    };
};
