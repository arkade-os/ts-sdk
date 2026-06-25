import bolt11 from "light-bolt11-decoder";
import { DecodedInvoice } from "../types";
import { ArkAddress } from "@arkade-os/sdk";

/**
 * Decodes a Lightning invoice.
 * @param invoice - The Lightning invoice to decode.
 * @returns The decoded invoice.
 */
export const decodeInvoice = (invoice: string): DecodedInvoice => {
    const decoded = bolt11.decode(invoice);
    const millisats = BigInt(decoded.sections.find((s) => s.name === "amount")?.value ?? "0");
    return {
        expiry: decoded.expiry ?? 3600,
        amountSats: Number(millisats / 1000n),
        description: decoded.sections.find((s) => s.name === "description")?.value ?? "",
        // description_hash (BOLT11 `h`) is missing from light-bolt11-decoder's
        // Section union even though the decoder emits it. Widen just this lookup
        // rather than patch the library's types (separate repo, out of scope).
        descriptionHash:
            (decoded.sections as Array<{ name: string; value?: string }>).find(
                (s) => s.name === "description_hash",
            )?.value ?? "",
        paymentHash: decoded.sections.find((s) => s.name === "payment_hash")?.value ?? "",
    };
};

export const getInvoiceSatoshis = (invoice: string): number => {
    return decodeInvoice(invoice).amountSats;
};

export const getInvoicePaymentHash = (invoice: string): string => {
    return decodeInvoice(invoice).paymentHash;
};

export const isValidArkAddress = (address: string): boolean => {
    try {
        ArkAddress.decode(address);
        return true;
    } catch (e) {
        return false;
    }
};
