import { ArkAddress } from "../index";

/** True for a BOLT11 invoice (with or without a `lightning:` prefix). */
export const isLightningInvoice = (raw: string): boolean =>
    /^ln(bc|tb|bcrt|bs)/i.test(raw.replace(/^lightning:/i, ""));

/** True for an LNURL or a Lightning address (`user@host`). */
export const isLnurl = (raw: string): boolean =>
    /^lnurl/i.test(raw) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);

/** True for a bech32 (segwit) or base58 (legacy) Bitcoin address — format only,
 *  not a checksum check (the rail/SDK validates fully before spending). */
export const isBtcAddress = (raw: string): boolean =>
    /^(bc1|tb1|bcrt1)[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,90}$/i.test(raw) ||
    /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(raw);

/** True if the string decodes as an Arkade address. */
export const isArkAddress = (raw: string): boolean => {
    try {
        ArkAddress.decode(raw);
        return true;
    } catch {
        return false;
    }
};
