/**
 * Swap metadata — the facts a funding tx must carry for a receipt to survive
 * the loss of local storage.
 *
 * A swap record is otherwise rebuilt from chain (see `restore.ts`), and that
 * works because the offer packet names the covenant. Two things it cannot
 * rebuild:
 *
 * 1. **The quoted fee rate.** It is a term of the quote, not of the covenant,
 *    so nothing on chain records it. Without it a restored swap cannot show
 *    what the swap cost or what rate it got — the consumer either persists a
 *    quote-time snapshot (which dies with the same storage the scan is
 *    recovering from) or approximates it from the market's *current* card,
 *    which is a different number than the one the user agreed to.
 * 2. **A lightning send's covenant.** Its funding tx is an ordinary send: no
 *    packet, so nothing marks it as a swap at all. The covenant address is a
 *    taproot output whose key commits to the script tree without revealing it,
 *    and the inputs needed to re-derive it (`payment_hash` from the invoice,
 *    `solver_pubkey` and `refund_locktime` from the quote) all die with the
 *    quote. A restored lightning send is indistinguishable from having paid
 *    someone's ark address.
 *
 * Both are fixed the same way: put the facts in the funding tx, where the
 * restore scan already looks.
 *
 * **This packet binds nothing.** Unlike the offer packet, whose payload names
 * the terms a covenant enforces, everything here is descriptive — a wrong fee
 * rate misprices a receipt, it cannot mis-spend a coin. That difference is why
 * the two decoders take opposite positions on unknown records: see
 * {@link decodeSwapMeta}.
 *
 * PROPOSED WIRE FORMAT. `0x04` is not an allocated packet type — `0x03` (the
 * offer) is the only one assigned today. The number and the field tags below
 * need sign-off from the solver side before anything writes them in
 * production, because a solver that rejects an unrecognised packet would fail
 * every funding tx carrying one. Reading is safe to ship ahead of that;
 * writing is not.
 */
import { concatBytes } from "@scure/btc-signer/utils.js";

/** Extension packet type tag for swap metadata. PROPOSED — see the file note. */
export const SWAP_META_PACKET_TYPE = 0x04;

/**
 * Descriptive facts about a swap, recorded in its funding tx.
 *
 * Every field is optional: an offer swap carries the fee alone, a lightning
 * send carries the covenant and its terms, and a consumer that knows neither
 * writes no packet at all.
 */
export interface SwapMeta {
    /** The quoted fee, basis points. The rate the user actually agreed to. */
    feeBps?: number;
    /**
     * The lightning lockup's scriptPubKey (34 bytes).
     *
     * Carried outright rather than re-derived from the fields below. The
     * derivation also takes the ark signer key, the emulator key and the
     * unilateral exit delay, all read from live server state at restore time —
     * so a key rotation between funding and restore would silently derive a
     * different address and report the swap as never funded. The offer packet
     * pins `emulatorPubkey` for the same reason.
     */
    swapPkScript?: Uint8Array;
    /** `sha256(P)` (32 bytes) — ties the covenant back to its invoice. */
    paymentHash?: Uint8Array;
    /** The solver's x-only key (32 bytes) — who the claim path pays. */
    solverPubkey?: Uint8Array;
    /** Absolute locktime after which the refund path opens. */
    refundLocktime?: number;
}

/** Wire fields: tag plus exact byte width, in one table so a tag can never
 * drift from its width. Mirrors `offer.ts`'s FIELDS deliberately — the two
 * payloads are read by the same kind of scan and should not need two mental
 * models. Tags are packet-local: `0x01` here is unrelated to `0x01` in the
 * offer packet, exactly as in any TLV namespace. */
const FIELDS = {
    feeBps: { tag: 0x01, width: 2 },
    swapPkScript: { tag: 0x02, width: 34 },
    paymentHash: { tag: 0x03, width: 32 },
    solverPubkey: { tag: 0x04, width: 32 },
    refundLocktime: { tag: 0x05, width: 4 },
} as const;

type FieldName = keyof typeof FIELDS;

const NAMES = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [f.tag, k])) as Record<
    number,
    FieldName
>;

/** Basis points are a fraction of 10 000; at or above it the "fee" consumes
 * the whole swap, which is a mis-encoding rather than an expensive quote. */
const BPS_DENOMINATOR = 10_000;

function tlv(type: number, value: Uint8Array): Uint8Array {
    return concatBytes(Uint8Array.of(type, (value.length >> 8) & 0xff, value.length & 0xff), value);
}

const uint = (value: number, width: 2 | 4): Uint8Array => {
    const bytes = new Uint8Array(width);
    const view = new DataView(bytes.buffer);
    if (width === 2) view.setUint16(0, value, false);
    else view.setUint32(0, value, false);
    return bytes;
};

/**
 * Serialize swap metadata to TLV bytes (the packet payload).
 *
 * Rejects out-of-range values rather than emitting a record that would decode
 * to a different number than the caller passed: a `feeBps` past the u16 would
 * wrap to a small fee and read as a bargain, and a negative or fractional one
 * is not a rate at all. Encoding validates what decoding validates, so a
 * malformed value fails at its source instead of at every later reader.
 */
export function encodeSwapMeta(meta: SwapMeta): Uint8Array {
    const recs: Uint8Array[] = [];
    if (meta.feeBps !== undefined) {
        if (!Number.isInteger(meta.feeBps) || meta.feeBps < 0 || meta.feeBps >= BPS_DENOMINATOR) {
            throw new Error("feeBps must be an integer in [0, 10000)");
        }
        recs.push(tlv(FIELDS.feeBps.tag, uint(meta.feeBps, 2)));
    }
    for (const name of ["swapPkScript", "paymentHash", "solverPubkey"] as const) {
        const value = meta[name];
        if (value === undefined) continue;
        if (value.length !== FIELDS[name].width) {
            throw new Error(`${name} must be ${FIELDS[name].width} bytes`);
        }
        recs.push(tlv(FIELDS[name].tag, value));
    }
    if (meta.refundLocktime !== undefined) {
        if (
            !Number.isInteger(meta.refundLocktime) ||
            meta.refundLocktime < 0 ||
            meta.refundLocktime > 0xffffffff
        ) {
            throw new Error("refundLocktime must be a u32");
        }
        recs.push(tlv(FIELDS.refundLocktime.tag, uint(meta.refundLocktime, 4)));
    }
    return concatBytes(...recs);
}

/**
 * Parse TLV bytes into swap metadata.
 *
 * **Unknown records are ignored, and that is the deliberate opposite of
 * {@link decodeOffer}.** The offer packet binds a covenant, so a record it
 * cannot interpret means terms it does not understand and it must fail loudly
 * rather than display or cancel an offer it has only partly read. Nothing here
 * binds anything: an unread record costs at most a row on a receipt. Making
 * this packet strict would instead mean that adding any future field
 * immediately breaks every older reader — the failure mode a descriptive
 * packet exists to avoid.
 *
 * Malformed records are still rejected. A truncated header or a wrong-width
 * value is not a field from the future, it is corruption, and silently reading
 * a short `feeBps` as a plausible small number is worse than admitting the
 * payload is unusable.
 */
export function decodeSwapMeta(data: Uint8Array): SwapMeta {
    const fields: Partial<Record<FieldName, Uint8Array>> = {};
    let off = 0;
    while (off < data.length) {
        if (off + 3 > data.length) throw new Error("truncated TLV header");
        const type = data[off];
        const length = (data[off + 1] << 8) | data[off + 2];
        off += 3;
        if (off + length > data.length) {
            throw new Error(`truncated TLV value for type 0x${type.toString(16)}`);
        }
        const name = NAMES[type];
        const value = data.slice(off, off + length);
        off += length;
        if (!name) continue; // a field from a newer writer; see the doc comment
        // last-wins would let the same bytes decode differently in an
        // implementation that takes the first record
        if (fields[name] !== undefined) throw new Error(`duplicate TLV record: ${name}`);
        if (value.length !== FIELDS[name].width) throw new Error(`invalid ${name}`);
        fields[name] = value;
    }

    const meta: SwapMeta = {};
    const view = (v: Uint8Array) => new DataView(v.buffer, v.byteOffset, v.byteLength);
    if (fields.feeBps) {
        const feeBps = view(fields.feeBps).getUint16(0, false);
        // an encoder of ours cannot produce this; a foreign one can, and a fee
        // at or past the denominator would render as a nonsensical receipt
        if (feeBps >= BPS_DENOMINATOR) throw new Error("invalid feeBps");
        meta.feeBps = feeBps;
    }
    if (fields.swapPkScript) meta.swapPkScript = fields.swapPkScript;
    if (fields.paymentHash) meta.paymentHash = fields.paymentHash;
    if (fields.solverPubkey) meta.solverPubkey = fields.solverPubkey;
    if (fields.refundLocktime)
        meta.refundLocktime = view(fields.refundLocktime).getUint32(0, false);
    return meta;
}
