import { hex } from "@scure/base";
import type { ExtensionPacket } from "../extension/packet";
import { AssetId } from "../extension/asset";
import { BufferReader } from "../extension/utils";

const TLV_SWAP_ADDRESS = 0x01;
const TLV_WANT_AMOUNT = 0x02;
const TLV_WANT_ASSET = 0x03;
const TLV_CANCEL_DELAY = 0x04;
const TLV_MAKER_PK_SCRIPT = 0x05;
const TLV_MAKER_PUBLIC_KEY = 0x07;
const TLV_INTROSPECTOR_PUBKEY = 0x08;
const TLV_RATIO_NUM = 0x09;
const TLV_RATIO_DEN = 0x0a;
const TLV_OFFER_ASSET = 0x0b;

const KNOWN_TYPES = new Set([
    TLV_SWAP_ADDRESS,
    TLV_WANT_AMOUNT,
    TLV_WANT_ASSET,
    TLV_CANCEL_DELAY,
    TLV_MAKER_PK_SCRIPT,
    TLV_MAKER_PUBLIC_KEY,
    TLV_INTROSPECTOR_PUBKEY,
    TLV_RATIO_NUM,
    TLV_RATIO_DEN,
    TLV_OFFER_ASSET,
]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function writeTLV(type: number, value: Uint8Array): Uint8Array {
    const record = new Uint8Array(3 + value.length);
    record[0] = type;
    record[1] = (value.length >> 8) & 0xff;
    record[2] = value.length & 0xff;
    record.set(value, 3);
    return record;
}

function writeUint64BE(n: bigint): Uint8Array {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, n, false);
    return buf;
}

function readUint64BE(buf: Uint8Array): bigint {
    return new DataView(
        buf.buffer,
        buf.byteOffset,
        buf.byteLength
    ).getBigUint64(0, false);
}

/**
 * Banco swap offer — an Extension packet (type `0x03`) that encodes all
 * the information a taker needs to fulfill a swap.
 *
 * When stored in the funding transaction's extension output, the taker
 * only needs the txid to discover and fulfill the offer.
 *
 * Wire format (inside the Extension TLV envelope):
 *   sequence of `[type: 1B][length: 2B BE][value]` records.
 *
 * | Type   | Field              | Encoding                             |
 * |--------|--------------------|--------------------------------------|
 * | `0x01` | swapAddress        | UTF-8                                |
 * | `0x02` | wantAmount         | 8-byte big-endian uint64             |
 * | `0x03` | wantAsset          | UTF-8 `"txid:vout"` (optional)       |
 * | `0x04` | cancelDelay        | 8-byte big-endian uint64 (optional)  |
 * | `0x05` | makerPkScript      | raw bytes (34)                       |
 * | `0x07` | makerPublicKey     | raw bytes (32)                       |
 * | `0x08` | introspectorPubkey | raw bytes (32)                       |
 * | `0x09` | ratioNum           | 8-byte big-endian uint64 (optional)  |
 * | `0x0a` | ratioDen           | 8-byte big-endian uint64 (optional)  |
 * | `0x0b` | offerAsset         | raw AssetId bytes (optional)         |
 */
export namespace Offer {
    /** Extension packet type tag. */
    export const PACKET_TYPE = 0x03;

    /** All fields that describe a banco swap offer. */
    export interface Data {
        /** The ark address of the swap contract. */
        swapAddress: string;
        /** Amount the maker wants to receive (in sats). */
        wantAmount: bigint;
        /** Asset the maker wants, as `"txid:vout"`. Omitted when wanting BTC. */
        wantAsset?: AssetId;
        /** LE64 numerator: BTC sats paid per `ratioDen` asset units. */
        ratioNum?: bigint;
        /** LE64 denominator: asset units corresponding to `ratioNum` sats. */
        ratioDen?: bigint;
        /** Asset the maker is offering (locked in the VTXO). Omitted when offering BTC. */
        offerAsset?: AssetId;
        /** CLTV unix timestamp after which the maker can cancel. */
        cancelDelay?: bigint;
        /** Maker's full taproot scriptPubKey (34 bytes). */
        makerPkScript: Uint8Array;
        /** Maker's x-only taproot internal key (32 bytes). */
        makerPublicKey: Uint8Array;
        /** Introspector's x-only public key (32 bytes). */
        introspectorPubkey: Uint8Array;
    }

    /** Serialize offer fields into TLV bytes (the packet payload). */
    export function encode(offer: Data): Uint8Array {
        const records: Uint8Array[] = [];

        records.push(
            writeTLV(TLV_SWAP_ADDRESS, textEncoder.encode(offer.swapAddress))
        );
        records.push(
            writeTLV(TLV_WANT_AMOUNT, writeUint64BE(offer.wantAmount))
        );
        if (offer.wantAsset !== undefined) {
            records.push(writeTLV(TLV_WANT_ASSET, offer.wantAsset.serialize()));
        }
        if (offer.ratioNum !== undefined) {
            records.push(
                writeTLV(TLV_RATIO_NUM, writeUint64BE(offer.ratioNum))
            );
        }
        if (offer.ratioDen !== undefined) {
            records.push(
                writeTLV(TLV_RATIO_DEN, writeUint64BE(offer.ratioDen))
            );
        }
        if (offer.offerAsset !== undefined) {
            records.push(
                writeTLV(TLV_OFFER_ASSET, offer.offerAsset.serialize())
            );
        }
        if (offer.cancelDelay !== undefined) {
            records.push(
                writeTLV(TLV_CANCEL_DELAY, writeUint64BE(offer.cancelDelay))
            );
        }
        records.push(writeTLV(TLV_MAKER_PK_SCRIPT, offer.makerPkScript));
        records.push(writeTLV(TLV_MAKER_PUBLIC_KEY, offer.makerPublicKey));
        records.push(
            writeTLV(TLV_INTROSPECTOR_PUBKEY, offer.introspectorPubkey)
        );

        const totalLength = records.reduce((sum, r) => sum + r.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const r of records) {
            result.set(r, offset);
            offset += r.length;
        }
        return result;
    }

    /**
     * Parse TLV bytes into an offer.
     * @throws On truncated data, unknown types, missing required fields, or invalid lengths.
     */
    export function decode(data: Uint8Array): Data {
        let swapAddress: string | undefined;
        let wantAmount: bigint | undefined;
        let wantAsset: AssetId | undefined;
        let ratioNum: bigint | undefined;
        let ratioDen: bigint | undefined;
        let offerAsset: AssetId | undefined;
        let cancelDelay: bigint | undefined;
        let makerPkScript: Uint8Array | undefined;
        let makerPublicKey: Uint8Array | undefined;
        let introspectorPubkey: Uint8Array | undefined;

        let offset = 0;
        while (offset < data.length) {
            if (offset + 3 > data.length) {
                throw new Error(
                    "Truncated TLV: not enough bytes for type+length header"
                );
            }
            const type = data[offset];
            const length = (data[offset + 1] << 8) | data[offset + 2];
            offset += 3;

            if (offset + length > data.length) {
                throw new Error(
                    `Truncated TLV: expected ${length} bytes for type 0x${type.toString(16)}, got ${data.length - offset}`
                );
            }
            if (!KNOWN_TYPES.has(type)) {
                throw new Error(`Unknown TLV type: 0x${type.toString(16)}`);
            }

            const value = data.slice(offset, offset + length);
            offset += length;

            switch (type) {
                case TLV_SWAP_ADDRESS:
                    swapAddress = textDecoder.decode(value);
                    break;
                case TLV_WANT_AMOUNT:
                    wantAmount = readUint64BE(value);
                    break;
                case TLV_WANT_ASSET:
                    wantAsset = AssetId.fromReader(new BufferReader(value));
                    break;
                case TLV_RATIO_NUM:
                    ratioNum = readUint64BE(value);
                    break;
                case TLV_RATIO_DEN:
                    ratioDen = readUint64BE(value);
                    break;
                case TLV_OFFER_ASSET:
                    offerAsset = AssetId.fromReader(new BufferReader(value));
                    break;
                case TLV_CANCEL_DELAY:
                    cancelDelay = readUint64BE(value);
                    break;
                case TLV_MAKER_PK_SCRIPT:
                    makerPkScript = value;
                    break;
                case TLV_MAKER_PUBLIC_KEY:
                    makerPublicKey = value;
                    break;
                case TLV_INTROSPECTOR_PUBKEY:
                    introspectorPubkey = value;
                    break;
            }
        }

        if (!swapAddress)
            throw new Error("Missing required field: swapAddress");
        if (wantAmount === undefined)
            throw new Error("Missing required field: wantAmount");
        if (!makerPkScript)
            throw new Error("Missing required field: makerPkScript");
        if (!makerPublicKey)
            throw new Error("Missing required field: makerPublicKey");
        if (!introspectorPubkey)
            throw new Error("Missing required field: introspectorPubkey");

        if (makerPkScript.length !== 34) {
            throw new Error(
                `Invalid makerPkScript: expected 34 bytes, got ${makerPkScript.length}`
            );
        }
        if (makerPublicKey.length !== 32) {
            throw new Error(
                `Invalid makerPublicKey: expected 32 bytes, got ${makerPublicKey.length}`
            );
        }
        if (introspectorPubkey.length !== 32) {
            throw new Error(
                `Invalid introspectorPubkey: expected 32 bytes, got ${introspectorPubkey.length}`
            );
        }

        return {
            swapAddress,
            wantAmount,
            ...(wantAsset !== undefined && { wantAsset }),
            ...(ratioNum !== undefined && { ratioNum }),
            ...(ratioDen !== undefined && { ratioDen }),
            ...(offerAsset !== undefined && { offerAsset }),
            ...(cancelDelay !== undefined && { cancelDelay }),
            makerPkScript,
            makerPublicKey,
            introspectorPubkey,
        };
    }

    /** Encode an offer and return its hex representation. */
    export function toHex(offer: Data): string {
        return hex.encode(encode(offer));
    }

    /** Decode an offer from a hex string. */
    export function fromHex(h: string): Data {
        return decode(hex.decode(h));
    }

    /**
     * Create an ExtensionPacket wrapping this offer.
     * Embed in a funding tx's extension output so the taker can discover it by txid.
     */
    export function toPacket(offer: Data): ExtensionPacket {
        const payload = encode(offer);
        return {
            type: () => PACKET_TYPE,
            serialize: () => payload,
        };
    }

    /** Parse an offer from an ExtensionPacket payload. */
    export function fromPacket(data: Uint8Array): Data {
        return decode(data);
    }
}
