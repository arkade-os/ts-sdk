import { BIP21 } from "../utils/bip21";
import { isBtcAddress, isLightningInvoice, isValidArkAddress } from "./predicates";

/**
 * Per-rail target extraction from a raw request — bare target, or the matching
 * field of a unified BIP21 URI. Lives in core so plugin rails classify
 * identically to the built-in ones instead of re-deriving it.
 */

const fromBip21 = (
    raw: string,
    key: string,
    accept: (v: string) => boolean,
): string | undefined => {
    try {
        const v = BIP21.parse(raw).params[key];
        return typeof v === "string" && accept(v) ? v : undefined;
    } catch {
        return undefined;
    }
};

/** The ark address in `raw`: bare, or the `ark=` param. */
export const arkTarget = (raw: string): string | undefined =>
    isValidArkAddress(raw) ? raw : fromBip21(raw, "ark", isValidArkAddress);

/** The on-chain BTC address in `raw`: bare, or the URI's address. */
export const btcTarget = (raw: string): string | undefined =>
    isBtcAddress(raw) ? raw : fromBip21(raw, "address", isBtcAddress);

/** The bolt11 invoice in `raw` with any `lightning:` prefix stripped: bare, or
 *  the `lightning=` param. */
export const invoiceTarget = (raw: string): string | undefined => {
    const invoice = isLightningInvoice(raw) ? raw : fromBip21(raw, "lightning", isLightningInvoice);
    return invoice?.replace(/^lightning:/i, "");
};
