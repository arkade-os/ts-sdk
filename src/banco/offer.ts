import { hex } from "@scure/base";
import type { ExtensionPacket } from "../extension/packet";
import * as asset from "../extension/asset";
import { AssetId } from "../extension/asset";
import { BufferReader } from "../extension/utils";
import {
    CLTVMultisigTapscript,
    CSVMultisigTapscript,
    MultisigTapscript,
} from "../script/tapscript";
import type { RelativeTimelock } from "../script/tapscript";
import * as arkade from "../arkade";

const { ArkadeScript, ArkadeVtxoScript } = arkade;

const TLV_SWAP_PK_SCRIPT = 0x01;
const TLV_WANT_AMOUNT = 0x02;
const TLV_WANT_ASSET = 0x03;
const TLV_CANCEL_DELAY = 0x04;
const TLV_MAKER_PK_SCRIPT = 0x05;
const TLV_MAKER_PUBLIC_KEY = 0x07;
const TLV_INTROSPECTOR_PUBKEY = 0x08;
const TLV_RATIO_NUM = 0x09;
const TLV_RATIO_DEN = 0x0a;
const TLV_OFFER_ASSET = 0x0b;
const TLV_EXIT_TIMELOCK = 0x0c;

const KNOWN_TYPES = new Set([
    TLV_SWAP_PK_SCRIPT,
    TLV_WANT_AMOUNT,
    TLV_WANT_ASSET,
    TLV_CANCEL_DELAY,
    TLV_MAKER_PK_SCRIPT,
    TLV_MAKER_PUBLIC_KEY,
    TLV_INTROSPECTOR_PUBKEY,
    TLV_RATIO_NUM,
    TLV_RATIO_DEN,
    TLV_OFFER_ASSET,
    TLV_EXIT_TIMELOCK,
]);

function bigintToLE64(n: bigint): Uint8Array {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigInt64(0, n, true);
    return buf;
}

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
 * | `0x01` | swapPkScript       | raw bytes                            |
 * | `0x02` | wantAmount         | 8-byte big-endian uint64             |
 * | `0x03` | wantAsset          | UTF-8 `"txid:vout"` (optional)       |
 * | `0x04` | cancelDelay        | 8-byte big-endian uint64 (optional)  |
 * | `0x05` | makerPkScript      | raw bytes (34)                       |
 * | `0x07` | makerPublicKey     | raw bytes (32)                       |
 * | `0x08` | introspectorPubkey | raw bytes (32)                       |
 * | `0x09` | ratioNum           | 8-byte big-endian uint64 (optional)  |
 * | `0x0a` | ratioDen           | 8-byte big-endian uint64 (optional)  |
 * | `0x0b` | offerAsset         | raw AssetId bytes (optional)         |
 * | `0x0c` | exitTimelock       | 1B type + 8B BE uint64 (optional)    |
 */
export namespace Offer {
    /** Extension packet type tag. */
    export const PACKET_TYPE = 0x03;

    /** All fields that describe a banco swap offer. */
    export interface Data {
        /** The scriptPubKey of the swap contract. */
        swapPkScript: Uint8Array;
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
        /** Maker's x-only taproot internal key (32 bytes). Required when cancel or exit paths are present. */
        makerPublicKey?: Uint8Array;
        /** Introspector's x-only public key (32 bytes). */
        introspectorPubkey: Uint8Array;
        /** Relative timelock for unilateral exit. */
        exitTimelock?: RelativeTimelock;
    }

    /** Serialize offer fields into TLV bytes (the packet payload). */
    export function encode(offer: Data): Uint8Array {
        const records: Uint8Array[] = [];

        records.push(writeTLV(TLV_SWAP_PK_SCRIPT, offer.swapPkScript));
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
        if (offer.makerPublicKey !== undefined) {
            records.push(writeTLV(TLV_MAKER_PUBLIC_KEY, offer.makerPublicKey));
        }
        records.push(
            writeTLV(TLV_INTROSPECTOR_PUBKEY, offer.introspectorPubkey)
        );
        if (offer.exitTimelock !== undefined) {
            const buf = new Uint8Array(9);
            buf[0] = offer.exitTimelock.type === "seconds" ? 1 : 0;
            new DataView(buf.buffer).setBigUint64(
                1,
                offer.exitTimelock.value,
                false
            );
            records.push(writeTLV(TLV_EXIT_TIMELOCK, buf));
        }

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
        let swapPkScript: Uint8Array | undefined;
        let wantAmount: bigint | undefined;
        let wantAsset: AssetId | undefined;
        let ratioNum: bigint | undefined;
        let ratioDen: bigint | undefined;
        let offerAsset: AssetId | undefined;
        let cancelDelay: bigint | undefined;
        let makerPkScript: Uint8Array | undefined;
        let makerPublicKey: Uint8Array | undefined;
        let introspectorPubkey: Uint8Array | undefined;
        let exitTimelock: RelativeTimelock | undefined;

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
                case TLV_SWAP_PK_SCRIPT:
                    swapPkScript = value;
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
                case TLV_EXIT_TIMELOCK:
                    exitTimelock = {
                        type: value[0] === 1 ? "seconds" : "blocks",
                        value: new DataView(
                            value.buffer,
                            value.byteOffset + 1,
                            8
                        ).getBigUint64(0, false),
                    };
                    break;
            }
        }

        if (!swapPkScript)
            throw new Error("Missing required field: swapPkScript");
        if (wantAmount === undefined)
            throw new Error("Missing required field: wantAmount");
        if (!makerPkScript)
            throw new Error("Missing required field: makerPkScript");
        if (!introspectorPubkey)
            throw new Error("Missing required field: introspectorPubkey");

        if (makerPkScript.length !== 34) {
            throw new Error(
                `Invalid makerPkScript: expected 34 bytes, got ${makerPkScript.length}`
            );
        }
        if (makerPublicKey && makerPublicKey.length !== 32) {
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
            swapPkScript,
            wantAmount,
            ...(wantAsset !== undefined && { wantAsset }),
            ...(ratioNum !== undefined && { ratioNum }),
            ...(ratioDen !== undefined && { ratioDen }),
            ...(offerAsset !== undefined && { offerAsset }),
            ...(cancelDelay !== undefined && { cancelDelay }),
            ...(exitTimelock !== undefined && { exitTimelock }),
            ...(makerPublicKey !== undefined && { makerPublicKey }),
            makerPkScript,
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

    /** Whether this offer uses a partial-fill covenant (ratio-based). */
    export function isPartialFill(offer: Omit<Data, "swapPkScript">): boolean {
        return offer.ratioNum !== undefined && offer.ratioDen !== undefined;
    }

    /**
     * Returns the covenant script for the fulfill leaf.
     * Selects partial-fill script when ratio params are present,
     * otherwise falls back to full-fill script.
     */
    export function covenantScript(
        offer: Omit<Data, "swapPkScript">
    ): Uint8Array {
        return isPartialFill(offer)
            ? partialFillScript(offer)
            : fulfillScript(offer);
    }

    /** Builds the full VTXO taptree (fulfill + optional cancel + exit). */
    export function vtxoScript(
        offer: Omit<Data, "swapPkScript">,
        serverPubkey: Uint8Array
    ): arkade.ArkadeVtxoScript {
        const leaves: arkade.ArkadeVtxoInput[] = [
            {
                arkadeScript: covenantScript(offer),
                introspectors: [offer.introspectorPubkey],
                tapscript: MultisigTapscript.encode({
                    pubkeys: [serverPubkey],
                }),
            },
        ];

        if (offer.cancelDelay !== undefined) {
            if (!offer.makerPublicKey) {
                throw new Error(
                    "makerPublicKey is required when cancelDelay is set"
                );
            }
            leaves.push(
                CLTVMultisigTapscript.encode({
                    pubkeys: [offer.makerPublicKey, serverPubkey],
                    absoluteTimelock: offer.cancelDelay,
                }).script
            );
        }

        if (offer.exitTimelock !== undefined) {
            if (!offer.makerPublicKey) {
                throw new Error(
                    "makerPublicKey is required when exitTimelock is set"
                );
            }
            leaves.push(
                CSVMultisigTapscript.encode({
                    pubkeys: [offer.makerPublicKey, serverPubkey],
                    timelock: offer.exitTimelock,
                }).script
            );
        }

        return new ArkadeVtxoScript(leaves);
    }

    /** Full-fill arkade script. */
    function fulfillScript(offer: Omit<Data, "swapPkScript">): Uint8Array {
        const makerWitnessProgram = offer.makerPkScript.subarray(2);

        const scriptPubKeyCheck = [
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            makerWitnessProgram,
            "EQUAL",
        ] as const;

        const valueCheck = [
            0,
            "INSPECTOUTPUTVALUE",
            Number(offer.wantAmount),
            "SCRIPTNUMTOLE64",
            "GREATERTHANOREQUAL64",
            "VERIFY",
        ] as const;

        if (!offer.wantAsset) {
            return ArkadeScript.encode([...valueCheck, ...scriptPubKeyCheck]);
        }

        const txidInternalOrder = offer.wantAsset.txid.slice().reverse();

        return ArkadeScript.encode([
            0,
            txidInternalOrder,
            0,
            "INSPECTOUTASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "SCRIPTNUMTOLE64",
            Number(offer.wantAmount),
            "SCRIPTNUMTOLE64",
            "GREATERTHANOREQUAL64",
            "VERIFY",
            ...scriptPubKeyCheck,
        ]);
    }

    /** Partial-fill arkade script dispatcher. */
    function partialFillScript(offer: Omit<Data, "swapPkScript">): Uint8Array {
        const want = offer.wantAsset ?? "btc";
        const offerAsset = offer.offerAsset ?? "btc";

        if (want === "btc" && offerAsset === "btc") {
            throw new Error(
                "partialFillScript: offer and want cannot both be BTC"
            );
        }

        if (offerAsset === "btc") {
            return btcForAssetScript(offer);
        } else if (want === "btc") {
            return assetForBtcScript(offer);
        } else {
            return assetForAssetScript(offer);
        }
    }

    /** BTC -> asset partial fill script. */
    function btcForAssetScript(offer: Omit<Data, "swapPkScript">): Uint8Array {
        const want = offer.wantAsset as asset.AssetId;
        const makerWP = offer.makerPkScript.subarray(2);
        const ratioNumLE = bigintToLE64(offer.ratioNum!);
        const ratioDenLE = bigintToLE64(offer.ratioDen!);
        const zeroLE64 = new Uint8Array(8);
        const wantTxid = want.txid.slice().reverse();

        return ArkadeScript.encode([
            "PUSHCURRENTINPUTINDEX",
            0,
            "EQUALVERIFY",
            1,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            makerWP,
            "EQUALVERIFY",
            wantTxid,
            "DUP",
            "TOALTSTACK",
            want.groupIndex,
            "FINDASSETGROUPBYASSETID",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            1,
            "SWAP",
            "FROMALTSTACK",
            "SWAP",
            "INSPECTOUTASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "SCRIPTNUMTOLE64",
            "DUP",
            zeroLE64,
            "GREATERTHAN64",
            "VERIFY",
            ratioNumLE,
            "MUL64",
            "VERIFY",
            ratioDenLE,
            "DIV64",
            "VERIFY",
            "NIP",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTVALUE",
            "2DUP",
            "SWAP",
            "LESSTHANOREQUAL64",
            "IF",
            "2DROP",
            1,
            "ELSE",
            "SWAP",
            "SUB64",
            "VERIFY",
            0,
            "INSPECTOUTPUTVALUE",
            "EQUALVERIFY",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTSCRIPTPUBKEY",
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            "ROT",
            "EQUALVERIFY",
            "EQUAL",
            "ENDIF",
        ]);
    }

    /** asset -> BTC partial fill script. */
    function assetForBtcScript(offer: Omit<Data, "swapPkScript">): Uint8Array {
        const offerAsset = offer.offerAsset as asset.AssetId;
        const makerWP = offer.makerPkScript.subarray(2);
        const ratioNumLE = bigintToLE64(offer.ratioNum!);
        const ratioDenLE = bigintToLE64(offer.ratioDen!);
        const zeroLE64 = new Uint8Array(8);
        const offerTxid = offerAsset.txid.slice().reverse();

        return ArkadeScript.encode([
            "PUSHCURRENTINPUTINDEX",
            0,
            "EQUALVERIFY",
            1,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            makerWP,
            "EQUALVERIFY",
            1,
            "INSPECTOUTPUTVALUE",
            "DUP",
            zeroLE64,
            "GREATERTHAN64",
            "VERIFY",
            offerTxid,
            "DUP",
            "DUP",
            "TOALTSTACK",
            "TOALTSTACK",
            offerAsset.groupIndex,
            "FINDASSETGROUPBYASSETID",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "PUSHCURRENTINPUTINDEX",
            "SWAP",
            "FROMALTSTACK",
            "SWAP",
            "INSPECTINASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "SCRIPTNUMTOLE64",
            "TOALTSTACK",
            ratioNumLE,
            "MUL64",
            "VERIFY",
            ratioDenLE,
            "DIV64",
            "VERIFY",
            "NIP",
            "FROMALTSTACK",
            "2DUP",
            "SWAP",
            "LESSTHANOREQUAL64",
            "IF",
            "2DROP",
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            makerWP,
            "EQUALVERIFY",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTVALUE",
            0,
            "INSPECTOUTPUTVALUE",
            "EQUALVERIFY",
            1,
            "ELSE",
            "SWAP",
            "SUB64",
            "VERIFY",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTSCRIPTPUBKEY",
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            "ROT",
            "EQUALVERIFY",
            "EQUALVERIFY",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTVALUE",
            0,
            "INSPECTOUTPUTVALUE",
            "EQUALVERIFY",
            offerTxid,
            offerAsset.groupIndex,
            "FINDASSETGROUPBYASSETID",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            0,
            "SWAP",
            "FROMALTSTACK",
            "SWAP",
            "INSPECTOUTASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "SCRIPTNUMTOLE64",
            "EQUAL",
            "ENDIF",
        ]);
    }

    /** asset -> asset partial fill script. */
    function assetForAssetScript(
        offer: Omit<Data, "swapPkScript">
    ): Uint8Array {
        const want = offer.wantAsset as asset.AssetId;
        const offerAsset = offer.offerAsset as asset.AssetId;
        const makerWP = offer.makerPkScript.subarray(2);
        const ratioNumLE = bigintToLE64(offer.ratioNum!);
        const ratioDenLE = bigintToLE64(offer.ratioDen!);
        const zeroLE64 = new Uint8Array(8);
        const wantTxid = want.txid.slice().reverse();
        const offerTxid = offerAsset.txid.slice().reverse();

        return ArkadeScript.encode([
            "PUSHCURRENTINPUTINDEX",
            0,
            "EQUALVERIFY",
            1,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            makerWP,
            "EQUALVERIFY",
            wantTxid,
            "DUP",
            "TOALTSTACK",
            want.groupIndex,
            "FINDASSETGROUPBYASSETID",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            1,
            "SWAP",
            "FROMALTSTACK",
            "SWAP",
            "INSPECTOUTASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "SCRIPTNUMTOLE64",
            "DUP",
            zeroLE64,
            "GREATERTHAN64",
            "VERIFY",
            offerTxid,
            "DUP",
            "DUP",
            "TOALTSTACK",
            "TOALTSTACK",
            offerAsset.groupIndex,
            "FINDASSETGROUPBYASSETID",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "PUSHCURRENTINPUTINDEX",
            "SWAP",
            "FROMALTSTACK",
            "SWAP",
            "INSPECTINASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "SCRIPTNUMTOLE64",
            "TOALTSTACK",
            ratioNumLE,
            "MUL64",
            "VERIFY",
            ratioDenLE,
            "DIV64",
            "VERIFY",
            "NIP",
            "FROMALTSTACK",
            "2DUP",
            "SWAP",
            "LESSTHANOREQUAL64",
            "IF",
            "2DROP",
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            1,
            "EQUALVERIFY",
            makerWP,
            "EQUALVERIFY",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTVALUE",
            0,
            "INSPECTOUTPUTVALUE",
            "EQUALVERIFY",
            1,
            "ELSE",
            "SWAP",
            "SUB64",
            "VERIFY",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTSCRIPTPUBKEY",
            0,
            "INSPECTOUTPUTSCRIPTPUBKEY",
            "ROT",
            "EQUALVERIFY",
            "EQUALVERIFY",
            "PUSHCURRENTINPUTINDEX",
            "INSPECTINPUTVALUE",
            0,
            "INSPECTOUTPUTVALUE",
            "EQUALVERIFY",
            offerTxid,
            offerAsset.groupIndex,
            "FINDASSETGROUPBYASSETID",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            0,
            "SWAP",
            "FROMALTSTACK",
            "SWAP",
            "INSPECTOUTASSETLOOKUP",
            "DUP",
            "1NEGATE",
            "EQUAL",
            "NOT",
            "VERIFY",
            "SCRIPTNUMTOLE64",
            "EQUAL",
            "ENDIF",
        ]);
    }
}
