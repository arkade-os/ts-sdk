import { RawTx, SigHash, Transaction as BtcSignerTransaction } from "@scure/btc-signer";
import { PSBTOutput } from "@scure/btc-signer/psbt.js";
import { TxOpts } from "@scure/btc-signer/transaction.js";
import { Bytes, concatBytes } from "@scure/btc-signer/utils.js";
import { TapTreeCoder, toBIP371TapTree } from "../script/base";

/**
 * Transaction is a wrapper around the @scure/btc-signer Transaction class.
 * It adds the Arkade protocol specific options to the transaction.
 */
export class Transaction extends BtcSignerTransaction {
    static ARK_TX_OPTS: TxOpts = {
        unknown: "ignore",
        allowUnknownOutputs: true,
        allowUnknownInputs: true,
    };

    constructor(opts?: TxOpts) {
        super(withArkOpts(opts));
    }

    /**
     * Decode a PSBT. PSBTs carrying a legacy `PSBT_OUT_TAP_TREE` (see
     * {@link repairLegacyOutputTapTrees}) are repaired and decoded again
     * instead of being rejected.
     */
    static fromPSBT(psbt_: Bytes, opts?: TxOpts): Transaction {
        try {
            return BtcSignerTransaction.fromPSBT(psbt_, withArkOpts(opts));
        } catch (err) {
            const repaired = repairLegacyOutputTapTrees(psbt_);
            if (!repaired) throw err;
            return BtcSignerTransaction.fromPSBT(repaired, withArkOpts(opts));
        }
    }

    static fromRaw(raw: Bytes, opts?: TxOpts): Transaction {
        return BtcSignerTransaction.fromRaw(raw, withArkOpts(opts));
    }
}

function withArkOpts(opts?: TxOpts): TxOpts {
    return { ...Transaction.ARK_TX_OPTS, ...opts };
}

const PSBT_MAGIC = new Uint8Array([0x70, 0x73, 0x62, 0x74, 0xff]);
const PSBT_GLOBAL_UNSIGNED_TX = 0x00;
const PSBT_GLOBAL_INPUT_COUNT = 0x04;
const PSBT_OUT_TAP_TREE = 0x06;

type PsbtKeyValue = { key: Uint8Array; value: Uint8Array };

/**
 * Rewrite every `PSBT_OUT_TAP_TREE` written in the legacy
 * `VtxoScript.encode()` form (every leaf at depth 1) into a BIP-371 tree.
 *
 * SDK releases before the scure 2.4 upgrade put `VtxoScript.encode()` bytes
 * straight into this field. For any leaf count other than 2 those depths do
 * not describe a binary tree, which scure >= 2.4 rejects on decode
 * ("tapTree: tuples must be in DFS order"). Such transactions are already
 * stored by indexers, so they must stay decodable. Only the PSBT field
 * changes: the txid and every signature are unaffected.
 *
 * @returns The repaired PSBT, or `undefined` if no output needed repair.
 */
export function repairLegacyOutputTapTrees(psbt: Bytes): Uint8Array | undefined {
    let maps: PsbtKeyValue[][];
    let inputsCount: number;
    try {
        maps = readPsbtMaps(psbt);
        inputsCount = psbtInputsCount(maps[0]);
    } catch {
        return undefined;
    }

    let repaired = false;
    for (const output of maps.slice(1 + inputsCount)) {
        for (const kv of output) {
            if (kv.key.length !== 1 || kv.key[0] !== PSBT_OUT_TAP_TREE) continue;
            const value = legacyTapTreeToBIP371(kv.value);
            if (!value) continue;
            kv.value = value;
            repaired = true;
        }
    }
    return repaired ? writePsbtMaps(maps) : undefined;
}

function legacyTapTreeToBIP371(value: Uint8Array): Uint8Array | undefined {
    try {
        PSBTOutput.tapTree[2].decode(value);
        return undefined; // already valid
    } catch {
        // fall through: only the legacy all-depth-1 form is repaired
    }
    let leaves: ReturnType<typeof TapTreeCoder.decode>;
    try {
        leaves = TapTreeCoder.decode(value);
    } catch {
        return undefined;
    }
    if (leaves.length === 0 || leaves.some((leaf) => leaf.depth !== 1)) return undefined;
    try {
        return TapTreeCoder.encode(toBIP371TapTree(value));
    } catch {
        // Not a tree VtxoScript can rebuild: leave it, so the caller surfaces
        // the original decode error rather than this one.
        return undefined;
    }
}

function psbtInputsCount(global: PsbtKeyValue[]): number {
    for (const { key, value } of global) {
        if (key.length !== 1) continue;
        if (key[0] === PSBT_GLOBAL_UNSIGNED_TX) return RawTx.decode(value).inputs.length;
        if (key[0] === PSBT_GLOBAL_INPUT_COUNT) return readCompactSize(value, 0)[0];
    }
    throw new Error("PSBT: missing input count");
}

/** Split a PSBT into its raw key-value maps (global, inputs, outputs) without decoding fields. */
function readPsbtMaps(psbt: Bytes): PsbtKeyValue[][] {
    for (let i = 0; i < PSBT_MAGIC.length; i++) {
        if (psbt[i] !== PSBT_MAGIC[i]) throw new Error("PSBT: invalid magic");
    }
    const maps: PsbtKeyValue[][] = [];
    let pos = PSBT_MAGIC.length;
    while (pos < psbt.length) {
        const map: PsbtKeyValue[] = [];
        for (;;) {
            const [keyLen, afterKeyLen] = readCompactSize(psbt, pos);
            pos = afterKeyLen;
            if (keyLen === 0) break;
            const key = readBytes(psbt, pos, keyLen);
            pos += keyLen;
            const [valueLen, afterValueLen] = readCompactSize(psbt, pos);
            pos = afterValueLen;
            const value = readBytes(psbt, pos, valueLen);
            pos += valueLen;
            map.push({ key, value });
        }
        maps.push(map);
    }
    if (maps.length === 0) throw new Error("PSBT: missing global map");
    return maps;
}

function writePsbtMaps(maps: PsbtKeyValue[][]): Uint8Array {
    const parts: Uint8Array[] = [PSBT_MAGIC];
    for (const map of maps) {
        for (const { key, value } of map) {
            parts.push(writeCompactSize(key.length), key, writeCompactSize(value.length), value);
        }
        parts.push(new Uint8Array([0]));
    }
    return concatBytes(...parts);
}

function readBytes(data: Bytes, pos: number, len: number): Uint8Array {
    if (pos + len > data.length) throw new Error("PSBT: unexpected end of data");
    return data.slice(pos, pos + len);
}

/** @returns [value, position after the compact size] */
function readCompactSize(data: Bytes, pos: number): [number, number] {
    const first = readBytes(data, pos, 1)[0];
    if (first < 0xfd) return [first, pos + 1];
    const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    const bytes = readBytes(data, pos + 1, width);
    let value = 0;
    for (let i = width - 1; i >= 0; i--) value = value * 256 + bytes[i];
    if (!Number.isSafeInteger(value)) throw new Error("PSBT: compact size too large");
    return [value, pos + 1 + width];
}

function writeCompactSize(value: number): Uint8Array {
    if (value < 0xfd) return new Uint8Array([value]);
    const width = value <= 0xffff ? 2 : value <= 0xffffffff ? 4 : 8;
    const out = new Uint8Array(1 + width);
    out[0] = width === 2 ? 0xfd : width === 4 ? 0xfe : 0xff;
    for (let i = 0, v = value; i < width; i++, v = Math.floor(v / 256)) out[1 + i] = v % 256;
    return out;
}

/** Formats a sighash type as a hex string (e.g., 0x01) */
export function formatSighash(type: number): string {
    return `0x${type.toString(16).padStart(2, "0")}`;
}

/**
 * Reject a PSBT that declares a sighash type outside `allowedSighashTypes` on
 * any input, before it reaches a signer. An input carrying no explicit type is
 * left alone: the signer treats a taproot input as {@link SigHash.DEFAULT}.
 */
export function assertAllowedSighashTypes(
    tx: BtcSignerTransaction,
    allowedSighashTypes: number[] = [SigHash.DEFAULT],
): void {
    for (let i = 0; i < tx.inputsLength; i++) {
        const declared = tx.getInput(i).sighashType;
        if (declared === undefined) continue;
        if (!allowedSighashTypes.includes(declared)) {
            throw new Error(`Unallowed sighash type ${formatSighash(declared)} for input ${i}.`);
        }
    }
}
