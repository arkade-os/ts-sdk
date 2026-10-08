/**
 * A BOLT11 encoder, for the decoder's test vectors.
 *
 * The corridor's decoder is signature-blind — `light-bolt11-decoder` does not
 * check signatures and says so — so an invoice is "real" here in every sense
 * the decoder can observe: a valid bech32 checksum, a well-formed HRP with its
 * amount inside it, a 35-bit timestamp and correctly length-prefixed tagged
 * fields. Only the 65-byte signature is filler.
 *
 * Written rather than collected because the vectors have to span the HRP table,
 * and published invoices exist only for mainnet. The one mainnet invoice the
 * suite uses is a real one, which is what pins this encoder against reality.
 */
import { bech32 } from "@scure/base";
import { hex } from "@scure/base";

/** The tag codes the vectors need. Values are BOLT11's. */
const TAGCODES = {
    payment_hash: 1,
    expiry: 6,
    description: 13,
} as const;

/** Big-endian 5-bit words, `count` of them. */
const intToWords = (value: number, count: number): number[] => {
    const words: number[] = [];
    let rest = value;
    for (let i = 0; i < count; i++) {
        words.unshift(rest % 32);
        rest = Math.floor(rest / 32);
    }
    return words;
};

/** The same, in as few words as the value needs. */
const minimalWords = (value: number): number[] => {
    let count = 1;
    while (value >= 32 ** count) count += 1;
    return intToWords(value, count);
};

const taggedField = (tag: number, dataWords: number[]): number[] => [
    tag,
    ...intToWords(dataWords.length, 2),
    ...dataWords,
];

export interface InvoiceParts {
    /** The network prefix: `lnbc`, `lntb`, `lntbs`, `lnbcrt` or `lnsb`. */
    prefix: string;
    /** The amount as it rides inside the HRP (`"20u"`). Omit for an amountless
     * invoice, which BOLT11 permits and which lets a payer pay anything. */
    amount?: string;
    /** Invoice creation time, unix seconds. */
    timestamp: number;
    /** The `x` tag, in seconds RELATIVE to the timestamp. Omit to leave BOLT11's
     * 3600-second default in force. */
    expiry?: number;
    /** `sha256(P)`, 64 lowercase hex chars. Omit to build the malformed
     * invoice BOLT11 forbids — no `p` tag at all. */
    paymentHash?: string;
    description?: string;
}

export const encodeInvoice = (parts: InvoiceParts): string => {
    const fields = [
        ...(parts.paymentHash === undefined
            ? []
            : taggedField(TAGCODES.payment_hash, bech32.toWords(hex.decode(parts.paymentHash)))),
        ...taggedField(
            TAGCODES.description,
            bech32.toWords(new TextEncoder().encode(parts.description ?? "test")),
        ),
        ...(parts.expiry === undefined
            ? []
            : taggedField(TAGCODES.expiry, minimalWords(parts.expiry))),
    ];
    const words = [
        ...intToWords(parts.timestamp, 7),
        ...fields,
        // 65 bytes of signature, which nothing on this path verifies.
        ...new Array<number>(104).fill(0),
    ];
    return bech32.encode(`${parts.prefix}${parts.amount ?? ""}`, words, Number.MAX_SAFE_INTEGER);
};
