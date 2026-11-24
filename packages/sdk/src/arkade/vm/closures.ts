import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToNumberBE, equalBytes } from "@noble/curves/utils.js";
import { hex } from "@scure/base";
import { KIND, messageOf, prefixed } from "./errors";
import { MaxScriptElementSize, MaxScriptSize } from "./limits";
import { checkMinimalDataEncoding, scriptNumBytes } from "./scriptnum";
import { ScriptTokenizer } from "./tokenizer";
import { taggedHash, tapLeafHash } from "./tx";

type Point = ReturnType<typeof schnorr.utils.lift_x>;

const OP_0 = 0x00;
const OP_DATA_32 = 0x20;
const OP_PUSHDATA4 = 0x4e;
const OP_1 = 0x51;
const OP_16 = 0x60;
const OP_VERIFY = 0x69;
const OP_DROP = 0x75;
const OP_NUMEQUAL = 0x9c;
const OP_CHECKSIG = 0xac;
const OP_CHECKSIGVERIFY = 0xad;
const OP_CHECKLOCKTIMEVERIFY = 0xb1;
const OP_CHECKSEQUENCEVERIFY = 0xb2;
const OP_CHECKSIGADD = 0xba;

/** schnorr.ParsePubKey: the even-y point of a 32-byte x coordinate. */
export function parseXOnlyPubKey(b: Uint8Array): Point {
    if (b.length !== 32) {
        throw new Error(`bad pubkey byte string size (want 32, have ${b.length})`);
    }
    const x = bytesToNumberBE(b);
    if (x >= secp256k1.Point.Fp.ORDER) throw new Error("invalid public key: x >= field prime");
    try {
        return schnorr.utils.lift_x(x);
    } catch {
        throw new Error(
            `invalid public key: x coordinate ${hex.encode(b)} is not on the secp256k1 curve`,
        );
    }
}

export interface ControlBlock {
    readonly leafVersion: number;
    readonly outputKeyYIsOdd: boolean;
    readonly internalKey: Point;
    readonly inclusionProof: Uint8Array;
}

/** txscript.ParseControlBlock. */
export function parseControlBlock(cb: Uint8Array): ControlBlock {
    if (cb.length < 33) {
        throw new Error(`min size is 33 bytes, control block is ${cb.length} bytes`);
    }
    if (cb.length > 33 + 128 * 32) {
        throw new Error(`max size is ${33 + 128 * 32}, control block is ${cb.length} bytes`);
    }
    if ((cb.length - 33) % 32 !== 0) {
        throw new Error(`control block proof is not a multiple of 32: ${cb.length - 33}`);
    }
    return {
        leafVersion: cb[0] & 0xfe,
        outputKeyYIsOdd: (cb[0] & 1) === 1,
        internalKey: parseXOnlyPubKey(cb.subarray(1, 33)),
        inclusionProof: cb.subarray(33),
    };
}

/** A txscript.Error raised outside the VM: ArkadeErrorCode leaves these codes out on purpose. */
export class TaprootError extends Error {
    constructor(
        readonly code:
            | typeof KIND.taprootMerkleProofInvalid
            | typeof KIND.taprootOutputKeyParityMismatch,
        message: string,
    ) {
        super(message);
        this.name = "TaprootError";
    }
}

/** txscript.VerifyTaprootLeafCommitment; `program` is the 32-byte witness program. */
export function verifyTaprootLeafCommitment(
    cb: ControlBlock,
    program: Uint8Array,
    script: Uint8Array,
): void {
    let root = tapLeafHash(cb.leafVersion, script);
    for (let o = 0; o < cb.inclusionProof.length; o += 32) {
        const node = cb.inclusionProof.subarray(o, o + 32);
        const i = root.findIndex((b, j) => b !== node[j]);
        root =
            i >= 0 && root[i] > node[i]
                ? taggedHash("TapBranch", node, root)
                : taggedHash("TapBranch", root, node);
    }
    const internalX = cb.internalKey.toBytes(true).subarray(1);
    const tweak = bytesToNumberBE(taggedHash("TapTweak", internalX, root));
    const key = cb.internalKey
        .add(secp256k1.Point.BASE.multiplyUnsafe(tweak % secp256k1.Point.Fn.ORDER))
        .toBytes(true);
    if (!equalBytes(key.subarray(1), program)) {
        throw new TaprootError(
            KIND.taprootMerkleProofInvalid,
            `derived witness program: ${hex.encode(key.subarray(1))}, expected: ${hex.encode(program)}, using tapscript_root: ${hex.encode(root)}`,
        );
    }
    const odd = key[0] === 0x03;
    if (cb.outputKeyYIsOdd !== odd) {
        throw new TaprootError(
            KIND.taprootOutputKeyParityMismatch,
            `control block y is odd: ${cb.outputKeyYIsOdd}, derived parity is odd: ${odd}`,
        );
    }
}

/** txscript.ScriptBuilder: the first error latches and script() throws it. */
class Builder {
    private readonly out: number[] = [];
    private err: string | undefined;

    private fits(n: number, message: string): boolean {
        if (this.err === undefined && this.out.length + n > MaxScriptSize) this.err = message;
        return this.err === undefined;
    }

    op(op: number): this {
        const msg = `adding an opcode would exceed the maximum allowed canonical script length of ${MaxScriptSize}`;
        if (this.fits(1, msg)) this.out.push(op);
        return this;
    }

    ops(ops: Uint8Array): this {
        const msg = `adding opcodes would exceed the maximum allowed canonical script length of ${MaxScriptSize}`;
        if (this.fits(ops.length, msg)) this.out.push(...ops);
        return this;
    }

    data(d: Uint8Array): this {
        const n = d.length;
        const small = n === 0 || (n === 1 && (d[0] <= 16 || d[0] === 0x81));
        const size = small ? 1 : n < 0x4c ? 1 + n : n <= 0xff ? 2 + n : n <= 0xffff ? 3 + n : 5 + n;
        const msg = `adding ${size} bytes of data would exceed the maximum allowed canonical script length of ${MaxScriptSize}`;
        if (!this.fits(size, msg)) return this;
        if (n > MaxScriptElementSize) {
            this.err = `adding a data element of ${n} bytes would exceed the maximum allowed script element size of ${MaxScriptElementSize}`;
            return this;
        }
        if (n === 0 || (n === 1 && d[0] === 0)) this.out.push(OP_0);
        else if (n === 1 && d[0] <= 16) this.out.push(OP_1 - 1 + d[0]);
        else if (n === 1 && d[0] === 0x81) this.out.push(0x4f);
        else if (n < 0x4c) this.out.push(n, ...d);
        else if (n <= 0xff) this.out.push(0x4c, n, ...d);
        else this.out.push(0x4d, n & 0xff, n >> 8, ...d);
        return this;
    }

    int64(n: number): this {
        const msg = `adding an integer would exceed the maximum allow canonical script length of ${MaxScriptSize}`;
        if (!this.fits(1, msg)) return this;
        if (n === 0) this.out.push(OP_0);
        else if (n === -1 || (n >= 1 && n <= 16)) this.out.push(OP_1 - 1 + n);
        else this.data(scriptNumBytes(n));
        return this;
    }

    script(): Uint8Array {
        if (this.err !== undefined) throw new Error(this.err);
        return Uint8Array.from(this.out);
    }
}

const opOf = (t: ScriptTokenizer): number => t.op?.value ?? -1;
const isSmallInt = (op: number): boolean => op === OP_0 || (op >= OP_1 && op <= OP_16);
// AsSmallInt subtracts in byte arithmetic, so a non-small opcode wraps instead of going negative
const asSmallInt = (op: number): number => (op === OP_0 ? 0 : (op - (OP_1 - 1)) & 0xff);
const isDataPush = (op: number): boolean => op >= 0x01 && op <= OP_PUSHDATA4;

/** txscript.MakeScriptNum over any width, with Go's int64 shifts (uint8 counts, >= 64 drops). */
function makeScriptNum(v: Uint8Array, maxLen: number): bigint {
    if (v.length > maxLen) {
        throw new Error(
            `numeric value encoded as ${hex.encode(v)} is ${v.length} bytes which exceeds the max allowed of ${maxLen}`,
        );
    }
    checkMinimalDataEncoding(v);
    if (v.length === 0) return 0n;
    const shift = (i: number) => (8 * i) % 256;
    let r = 0n;
    v.forEach((b, i) => {
        if (shift(i) < 64) r |= BigInt(b) << BigInt(shift(i));
    });
    r = BigInt.asIntN(64, r);
    if ((v[v.length - 1] & 0x80) === 0) return r;
    const s = shift(v.length - 1);
    if (s < 64) r &= ~BigInt.asIntN(64, 0x80n << BigInt(s));
    return BigInt.asIntN(64, -r);
}

/** BIP68DecodeSequenceFromBytes, returned as the sequence CSVMultisigClosure.Script() pushes. */
function bip68Sequence(seq: Uint8Array): number {
    const n = makeScriptNum(seq, seq.length);
    if (n & (1n << 31n)) throw new Error("sequence is disabled");
    const value = Number(n & 0xffffn);
    return n & (1n << 22n) ? (1 << 22) | value : value;
}

function multisigScript(keys: readonly Uint8Array[], checksigAdd: boolean): Uint8Array {
    const b = new Builder();
    keys.forEach((key, i) => {
        b.data(key);
        if (checksigAdd) b.op(i === 0 ? OP_CHECKSIG : OP_CHECKSIGADD);
        else b.op(i === keys.length - 1 ? OP_CHECKSIG : OP_CHECKSIGVERIFY);
    });
    if (checksigAdd) b.int64(keys.length).op(OP_NUMEQUAL);
    return b.script();
}

const xOnly = (data: Uint8Array): Uint8Array => {
    parseXOnlyPubKey(data);
    return data.slice();
};

function decodeChecksig(script: Uint8Array): Uint8Array[] | null {
    const t = new ScriptTokenizer(script);
    const keys: Uint8Array[] = [];
    while (t.next()) {
        if (opOf(t) !== OP_DATA_32) return null;
        keys.push(xOnly(t.data));
        if (!t.next()) return null;
        if (opOf(t) !== OP_CHECKSIGVERIFY) break;
    }
    if (t.err || opOf(t) !== OP_CHECKSIG || keys.length === 0) return null;
    return equalBytes(multisigScript(keys, false), script) ? keys : null;
}

function decodeChecksigAdd(script: Uint8Array): Uint8Array[] | null {
    const t = new ScriptTokenizer(script);
    const keys: Uint8Array[] = [];
    while (t.next()) {
        if (isSmallInt(opOf(t))) break;
        if (opOf(t) !== OP_DATA_32) return null;
        keys.push(xOnly(t.data));
        if (!t.next()) return null;
        if (opOf(t) !== OP_CHECKSIGADD && opOf(t) !== OP_CHECKSIG) return null;
    }
    if (t.err || keys.length !== asSmallInt(opOf(t))) return null;
    if (!t.next() || opOf(t) !== OP_NUMEQUAL) return null;
    return equalBytes(multisigScript(keys, true), script) ? keys : null;
}

function decodeMultisig(script: Uint8Array): Uint8Array[] | null {
    if (script.length === 0) throw new Error("failed to decode: script is empty");
    return (
        prefixed("failed to decode checksig", () => decodeChecksig(script)) ??
        prefixed("failed to decode checksigadd", () => decodeChecksigAdd(script))
    );
}

/** `locktime` prefix of a CLTV/CSV closure: the token, then `verify` and OP_DROP. */
function readLocktime(t: ScriptTokenizer, verify: number, cltv: boolean): Uint8Array | null {
    if (!t.next()) return null;
    const op = opOf(t);
    let seq: Uint8Array = new Uint8Array(0);
    if (isSmallInt(op)) {
        if (op !== OP_0) seq = Uint8Array.of(op - (OP_1 - 1));
    } else if (!isDataPush(op)) {
        return null;
    } else if (cltv) {
        const n = makeScriptNum(t.data, 6);
        if (n < 0n || n > 0xffffffffn) return null;
        if (n > 0n && n <= 16n) {
            throw new Error(`expected minimal encoding OP_${n} for locktime value ${n}`);
        }
    } else {
        seq = t.data;
    }
    for (const want of [verify, OP_DROP]) if (!t.next() || opOf(t) !== want) return null;
    return seq;
}

function decodeCsv(
    script: Uint8Array,
): { keys: Uint8Array[]; sequence: number; tail: Uint8Array } | null {
    if (script.length === 0) throw new Error("empty script");
    const t = new ScriptTokenizer(script);
    const seq = readLocktime(t, OP_CHECKSEQUENCEVERIFY, false);
    if (!seq) return null;
    const sequence = bip68Sequence(seq);
    const tail = script.subarray(t.byteIndex());
    const keys = decodeMultisig(tail);
    return keys && { keys, sequence, tail };
}

function decodeCltv(script: Uint8Array): Uint8Array[] | null {
    if (script.length === 0) throw new Error("empty script");
    const t = new ScriptTokenizer(script);
    if (!readLocktime(t, OP_CHECKLOCKTIMEVERIFY, true)) return null;
    return decodeMultisig(script.subarray(t.byteIndex()));
}

// btcd's forbiddenOpcodes for a condition: every signature and timelock check
const FORBIDDEN = new Set([0xae, 0xac, 0xad, 0xba, 0xaf, 0xb1, 0xb2]);

function validateConditionScript(condition: Uint8Array): void {
    if (condition.length > MaxScriptSize) {
        throw new Error(
            `condition script too large: ${condition.length} bytes, max ${MaxScriptSize}`,
        );
    }
    const t = new ScriptTokenizer(condition);
    while (t.next()) {
        if (FORBIDDEN.has(opOf(t))) {
            throw new Error(`forbidden opcode ${opOf(t).toString(16)} in condition script`);
        }
    }
    if (t.err) throw new Error(`failed to parse condition script: ${t.err.message}`);
}

function decodeCondition(script: Uint8Array, csv: boolean): Uint8Array[] | null {
    if (script.length === 0) throw new Error("empty script");
    const t = new ScriptTokenizer(script);
    const bytes: number[] = [];
    // keeps opcode and data but drops PUSHDATA length bytes, as Go does, so such pushes never rebuild
    while (t.next() && opOf(t) !== OP_VERIFY) bytes.push(opOf(t), ...t.data);
    const condition = Uint8Array.from(bytes);
    validateConditionScript(condition);
    const sub = script.subarray(t.byteIndex());
    let keys: Uint8Array[] | null;
    let inner = sub;
    if (csv) {
        const c = decodeCsv(sub);
        keys = c?.keys ?? null;
        if (c) {
            const lock = new Builder()
                .int64(c.sequence)
                .ops(Uint8Array.of(OP_CHECKSEQUENCEVERIFY, OP_DROP));
            inner = Uint8Array.from([...lock.script(), ...c.tail]);
        }
    } else {
        keys = decodeMultisig(sub);
    }
    if (!keys) return null;
    const rebuilt = new Builder().ops(condition).op(OP_VERIFY).ops(inner).script();
    return equalBytes(rebuilt, script) ? keys : null;
}

const DECODERS: readonly [string, (script: Uint8Array) => Uint8Array[] | null][] = [
    ["CSV Multisig", (s) => decodeCsv(s)?.keys ?? null],
    ["CLTV Multisig", decodeCltv],
    ["Multisig", decodeMultisig],
    ["Condition Multisig", (s) => decodeCondition(s, false)],
    ["Condition CSV Multisig", (s) => decodeCondition(s, true)],
];

// BIP-342 OP_SUCCESSx, as btcd's successOpcodes lists them
const OP_SUCCESS = new Set([
    80,
    98,
    126,
    127,
    128,
    129,
    131,
    132,
    133,
    134,
    137,
    138,
    141,
    142,
    149,
    150,
    151,
    152,
    153,
    ...Array.from({ length: 254 - 187 + 1 }, (_, i) => 187 + i),
]);

function hasOpSuccess(script: Uint8Array): boolean {
    const t = new ScriptTokenizer(script);
    while (t.next()) if (OP_SUCCESS.has(opOf(t))) return true;
    return false;
}

/** script.DecodeClosure, reduced to the x-only keys arkade.NewArkadeScript keeps. */
export function decodeClosure(script: Uint8Array): Uint8Array[] {
    if (script.length === 0) throw new Error("cannot decode empty script");
    if (hasOpSuccess(script)) throw new Error("script contains forbidden OP_SUCCESS opcode");
    const errors: string[] = [];
    for (const [name, decode] of DECODERS) {
        try {
            const keys = decode(script);
            if (keys) return keys;
        } catch (e) {
            errors.push(`${name}: ${messageOf(e)}`);
        }
    }
    if (errors.length > 0) {
        throw new Error(`failed to decode script ${hex.encode(script)}.\n${errors.join("\n")}`);
    }
    throw new Error(`script does not match any known closure type: ${hex.encode(script)}`);
}
