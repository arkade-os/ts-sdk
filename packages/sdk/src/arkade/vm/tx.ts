import { sha256 } from "@noble/hashes/sha2.js";
import type { Transaction } from "@scure/btc-signer";
import { KIND, plainError } from "./errors";
import type { ArkPrevOutFetcher } from "./fetcher";

/** `txid` in internal byte order (chainhash.Hash[:]), the reverse of the displayed id. */
export interface OutPoint {
    readonly txid: Uint8Array;
    readonly index: number;
}

export interface VmTxIn extends OutPoint {
    readonly sequence: number;
    readonly scriptSig: Uint8Array;
    readonly witness?: readonly Uint8Array[];
}

/** `value` is wire's int64; `script` is never nil (wire decodes an empty script as non-nil). */
export interface VmTxOut {
    readonly value: bigint;
    readonly script: Uint8Array;
}

/** `version` is wire's int32 read as a uint32, the view every arkade use converts it to. */
export interface VmTx {
    readonly version: number;
    readonly locktime: number;
    readonly inputs: readonly VmTxIn[];
    readonly outputs: readonly VmTxOut[];
}

class Writer {
    private chunks: Uint8Array[] = [];

    bytes(b: Uint8Array): this {
        this.chunks.push(b);
        return this;
    }

    u32(n: number): this {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, n >>> 0, true);
        return this.bytes(b);
    }

    i64(n: bigint): this {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, n), true);
        return this.bytes(b);
    }

    varInt(n: number): this {
        if (n < 0xfd) return this.bytes(Uint8Array.of(n));
        if (n <= 0xffff) return this.bytes(Uint8Array.of(0xfd, n & 0xff, n >>> 8));
        if (n <= 0xffffffff) return this.bytes(Uint8Array.of(0xfe)).u32(n);
        const b = new Uint8Array(9);
        b[0] = 0xff;
        new DataView(b.buffer).setBigUint64(1, BigInt(n), true);
        return this.bytes(b);
    }

    varBytes(b: Uint8Array): this {
        return this.varInt(b.length).bytes(b);
    }

    finish(): Uint8Array {
        const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
        let offset = 0;
        for (const c of this.chunks) {
            out.set(c, offset);
            offset += c.length;
        }
        return out;
    }
}

/** Fails as io.ReadFull and wire.ReadVarInt do. */
export class Reader {
    offset = 0;

    constructor(private readonly buf: Uint8Array) {}

    bytes(n: number): Uint8Array {
        const left = this.buf.length - this.offset;
        if (n > left) throw new Error(left === 0 ? "EOF" : "unexpected EOF");
        this.offset += n;
        return this.buf.slice(this.offset - n, this.offset);
    }

    u8(): number {
        return this.bytes(1)[0];
    }

    u32(): number {
        return new DataView(this.bytes(4).buffer).getUint32(0, true);
    }

    i64(): bigint {
        return new DataView(this.bytes(8).buffer).getBigInt64(0, true);
    }

    varInt(): number {
        const first = this.u8();
        if (first < 0xfd) return first;
        const b = this.bytes(first === 0xfd ? 2 : first === 0xfe ? 4 : 8);
        const v = b.reduceRight((acc, x) => (acc << 8n) | BigInt(x), 0n);
        const min = first === 0xfd ? 0xfdn : first === 0xfe ? 0x10000n : 0x100000000n;
        if (v < min) {
            throw new Error(
                `ReadVarInt: non-canonical varint ${v.toString(16)} - discriminant ${first.toString(16)} must encode a value greater than ${min.toString(16)}`,
            );
        }
        // ponytail: counts past 2^53 fail as in Go but print rounded; go bigint if the text matters
        return Number(v);
    }

    varBytes(): Uint8Array {
        return this.bytes(this.varInt());
    }
}

function writeTx(w: Writer, tx: VmTx, withWitness: boolean): Uint8Array {
    w.u32(tx.version);
    const witness = withWitness && tx.inputs.some((i) => (i.witness?.length ?? 0) > 0);
    if (witness) w.bytes(Uint8Array.of(0x00, 0x01));
    w.varInt(tx.inputs.length);
    for (const input of tx.inputs) {
        w.bytes(input.txid).u32(input.index).varBytes(input.scriptSig).u32(input.sequence);
    }
    w.varInt(tx.outputs.length);
    for (const output of tx.outputs) w.i64(output.value).varBytes(output.script);
    if (witness) for (const input of tx.inputs) writeWitness(w, input.witness ?? []);
    return w.u32(tx.locktime).finish();
}

function writeWitness(w: Writer, items: readonly Uint8Array[]): Writer {
    w.varInt(items.length);
    for (const item of items) w.varBytes(item);
    return w;
}

/** wire.MsgTx.Serialize: BIP-144 framing iff some input carries witness data. */
export const serializeTx = (tx: VmTx): Uint8Array => writeTx(new Writer(), tx, true);

export const serializeTxStripped = (tx: VmTx): Uint8Array => writeTx(new Writer(), tx, false);

export const serializeSizeStripped = (tx: VmTx): number => serializeTxStripped(tx).length;

/** wire.WriteTxOut. */
export const serializeTxOut = (out: VmTxOut): Uint8Array =>
    new Writer().i64(out.value).varBytes(out.script).finish();

/** psbt.WriteTxWitness. */
export const serializeWitness = (items: readonly Uint8Array[]): Uint8Array =>
    writeWitness(new Writer(), items).finish();

// wire v2.0.1's caps (msgtx.go:55-112, message.go:28)
const MAX_TX_IN = Math.floor((32 << 20) / 41) + 1;
const MAX_TX_OUT = Math.floor((32 << 20) / 9) + 1;
const MAX_WITNESS_ITEMS = 4_000_000;
const MAX_WITNESS_ITEM_SIZE = 4_000_000;
const SCRIPT_SLAB_SIZE = 1 << 22;

const tooMany = (what: string, count: number, max: number): Error =>
    new Error(
        `MsgTx.BtcDecode: too many ${what} to fit into max message size [count ${count}, max ${max}]`,
    );

/**
 * wire.MsgTx.Deserialize, or DeserializeNoWitness without `witness`. Like Go reading a stream it
 * stops after the locktime, so a caller that refuses trailing bytes checks `r.offset`.
 */
export function readTx(r: Reader, witness = true): VmTx {
    // every script and witness item is carved from one slab, so their total is capped too
    let slab = SCRIPT_SLAB_SIZE;
    const script = (field: string): Uint8Array => {
        const n = r.varInt();
        if (n > MAX_WITNESS_ITEM_SIZE) {
            throw new Error(
                `readScript: ${field} is larger than the max allowed size [count ${n}, max ${MAX_WITNESS_ITEM_SIZE}]`,
            );
        }
        if (n > slab) {
            throw new Error(
                `readScript: ${field} exceeds remaining buffer capacity [count ${n}, remaining ${slab}]`,
            );
        }
        slab -= n;
        return r.bytes(n);
    };
    const version = r.u32();
    let count = r.varInt();
    const flagged = witness && count === 0;
    if (flagged) {
        const flag = r.u8();
        if (flag !== 0x01) {
            const hex = flag.toString(16).padStart(2, "0");
            throw new Error(`MsgTx.BtcDecode: witness tx but flag byte is ${hex}`);
        }
        count = r.varInt();
    }
    if (count > MAX_TX_IN) throw tooMany("input transactions", count, MAX_TX_IN);
    const inputs: VmTxIn[] = [];
    for (let i = 0; i < count; i++) {
        inputs.push({
            txid: r.bytes(32),
            index: r.u32(),
            scriptSig: script("transaction input signature script"),
            sequence: r.u32(),
        });
    }
    const outCount = r.varInt();
    if (outCount > MAX_TX_OUT) throw tooMany("output transactions", outCount, MAX_TX_OUT);
    const outputs: VmTxOut[] = [];
    for (let i = 0; i < outCount; i++) {
        outputs.push({ value: r.i64(), script: script("transaction output public key script") });
    }
    const withWitness = inputs.map((input): VmTxIn => {
        if (!flagged) return input;
        const n = r.varInt();
        if (n > MAX_WITNESS_ITEMS) throw tooMany("witness items", n, MAX_WITNESS_ITEMS);
        const items: Uint8Array[] = [];
        for (let i = 0; i < n; i++) items.push(script("script witness item"));
        return { ...input, witness: items };
    });
    if (flagged && !withWitness.some((i) => (i.witness?.length ?? 0) > 0)) {
        throw new Error("witness flag set but tx has no witnesses");
    }
    return { version, locktime: r.u32(), inputs: withWitness, outputs };
}

export const parseTx = (raw: Uint8Array, witness = true): VmTx => readTx(new Reader(raw), witness);

/** The PSBT's unsigned tx, which is exactly what the emulator executes against. */
export const vmTxFromTransaction = (tx: Transaction): VmTx => parseTx(tx.unsignedTx, false);

export const sha256d = (b: Uint8Array): Uint8Array => sha256(sha256(b));

/** wire.MsgTx.TxHash: witness-stripped, internal byte order. */
export const txid = (tx: VmTx): Uint8Array => sha256d(serializeTxStripped(tx));

/** chainhash.TaggedHash; tags may be arbitrary script-supplied bytes. */
export function taggedHash(tag: Uint8Array | string, ...msgs: Uint8Array[]): Uint8Array {
    const t = sha256(typeof tag === "string" ? new TextEncoder().encode(tag) : tag);
    const h = sha256.create().update(t).update(t);
    for (const m of msgs) h.update(m);
    return h.digest();
}

/** txscript.TapLeaf.TapHash. */
export const tapLeafHash = (leafVersion: number, script: Uint8Array): Uint8Array =>
    taggedHash("TapLeaf", new Writer().bytes(Uint8Array.of(leafVersion)).varBytes(script).finish());

/** The four BIP-341 midstates the arkade sighash reads from txscript.TxSigHashes. */
export interface TxSigHashes {
    readonly hashPrevOutsV1: Uint8Array;
    readonly hashSequenceV1: Uint8Array;
    readonly hashInputAmountsV1: Uint8Array;
    readonly hashInputScriptsV1: Uint8Array;
}

export const isPayToTaproot = (s: Uint8Array): boolean =>
    s.length === 34 && s[0] === 0x51 && s[1] === 0x20;
const isCoinbaseOutPoint = (op: OutPoint): boolean =>
    op.index === 0xffffffff && op.txid.every((b) => b === 0);

/**
 * txscript.NewTxSigHashes (btcd txscript/v2): amounts and scripts stay all-zero unless some
 * non-coinbase input spends a P2TR-shaped prevout.
 */
export function computeTxSigHashes(
    tx: VmTx,
    fetcher: Pick<ArkPrevOutFetcher, "fetchPrevOutput">,
): TxSigHashes {
    const prevOut = (op: OutPoint) => {
        const out = fetcher.fetchPrevOutput(op);
        if (!out) throw plainError(KIND.panic, "NewTxSigHashes dereferenced a missing prevout");
        return out;
    };
    const hasV1 = tx.inputs.some(
        (i) => !isCoinbaseOutPoint(i) && isPayToTaproot(prevOut(i).script),
    );
    const hash = (fill: (w: Writer) => void) => {
        const w = new Writer();
        fill(w);
        return sha256(w.finish());
    };
    const zero = new Uint8Array(32);
    return {
        hashPrevOutsV1: hash((w) => tx.inputs.forEach((i) => w.bytes(i.txid).u32(i.index))),
        hashSequenceV1: hash((w) => tx.inputs.forEach((i) => w.u32(i.sequence))),
        hashInputAmountsV1: hasV1
            ? hash((w) => tx.inputs.forEach((i) => w.i64(prevOut(i).value)))
            : zero,
        hashInputScriptsV1: hasV1
            ? hash((w) => tx.inputs.forEach((i) => w.varBytes(prevOut(i).script)))
            : zero,
    };
}
