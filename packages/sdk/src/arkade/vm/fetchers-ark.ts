import { equalBytes } from "@noble/curves/utils.js";
import { hex } from "@scure/base";
import { parseControlBlock } from "./closures";
import { messageOf, prefixed } from "./errors";
import { type ArkPrevOutFetcher, MapArkPrevOutFetcher, outpointKey } from "./fetcher";
import { type OutPoint, parseTx, Reader, txid, type VmTx, type VmTxOut } from "./tx";

/** One PSBT key-value pair; null at a map's separator. */
function pair(r: Reader): { key: Uint8Array; value: Uint8Array } | null {
    const key = r.varBytes();
    return key.length === 0 ? null : { key, value: r.varBytes() };
}

export interface TapLeafScript {
    readonly controlBlock: Uint8Array;
    readonly script: Uint8Array;
    readonly leafVersion: number;
}

/** The psbt.PInput fields the emulator reads, in Go's serialized order. */
export interface PsbtInput {
    readonly witnessUtxo?: VmTxOut;
    readonly tapLeafScripts: readonly TapLeafScript[];
    readonly unknowns: readonly { readonly key: Uint8Array; readonly value: Uint8Array }[];
}

export interface Psbt {
    readonly tx: VmTx;
    readonly inputs: readonly PsbtInput[];
}

const MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff);
// psbt.InputType values Go decodes; every other key type lands in Unknowns
const KNOWN_INPUT_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18]);

const invalid = (why: string): Error => new Error(`invalid psbt: ${why}`);

function readInput(r: Reader): PsbtInput {
    let witnessUtxo: VmTxOut | undefined;
    const tapLeafScripts: TapLeafScript[] = [];
    const unknowns: { key: Uint8Array; value: Uint8Array }[] = [];
    for (let kv = pair(r); kv; kv = pair(r)) {
        const { key, value } = kv;
        const keyData = key.subarray(1);
        if (key[0] === 0x01) {
            if (witnessUtxo) throw invalid("duplicate key");
            if (keyData.length > 0) throw invalid("invalid key data");
            if (value.length < 10) throw invalid("invalid witness utxo");
            // psbt.readTxOut skips the script length byte without reading it
            const amount = new DataView(value.buffer, value.byteOffset).getBigInt64(0, true);
            witnessUtxo = { value: amount, script: value.slice(9) };
        } else if (key[0] === 0x15) {
            if (value.length < 1) throw invalid("invalid key data");
            try {
                parseControlBlock(keyData);
            } catch {
                throw invalid("invalid key data");
            }
            if (tapLeafScripts.some((l) => equalBytes(l.controlBlock, keyData))) {
                throw invalid("duplicate key");
            }
            tapLeafScripts.push({
                controlBlock: keyData.slice(),
                script: value.slice(0, -1),
                leafVersion: value[value.length - 1],
            });
        } else if (!KNOWN_INPUT_TYPES.has(key[0])) {
            if (unknowns.some((u) => equalBytes(u.key, key) && equalBytes(u.value, value))) {
                throw invalid("duplicate key");
            }
            unknowns.push({ key, value });
        }
    }
    return { witnessUtxo, tapLeafScripts, unknowns };
}

/**
 * psbt.NewFromRawBytes for the fields the emulator reads. Other known fields are skipped rather
 * than validated, so a PSBT Go would reject on one of those still parses here.
 */
export function readPsbt(raw: Uint8Array): Psbt {
    const r = new Reader(raw);
    try {
        if (!equalBytes(r.bytes(5), MAGIC)) throw invalid("magic bytes");
        const unsigned = pair(r);
        if (!unsigned || unsigned.key.length !== 1 || unsigned.key[0] !== 0x00) {
            throw invalid("unsigned tx must come first");
        }
        const tx = parseTx(unsigned.value, false);
        if (tx.inputs.some((i) => i.scriptSig.length > 0)) throw invalid("raw tx is signed");
        while (pair(r));
        const inputs = tx.inputs.map(() => readInput(r));
        tx.outputs.forEach(() => {
            while (pair(r));
        });
        return { tx, inputs };
    } catch (e) {
        throw messageOf(e).startsWith("invalid psbt") ? e : invalid(messageOf(e));
    }
}

/** chainhash.Hash.String(): the reversed, displayed form. */
export const displayHash = (h: Uint8Array): string => hex.encode(h.slice().reverse());

export const equalTxOut = (a: VmTxOut | undefined, b: VmTxOut): boolean =>
    a !== undefined && a.value === b.value && equalBytes(a.script, b.script);

/** Go's mapArkPrevOutFetcher, keeping prevOutIdxs and fetchVtxoPrevOut, which the gates read. */
export class ArkTxFetcher extends MapArkPrevOutFetcher {
    private readonly vouts = new Map<string, number>();

    constructor(
        prevOuts: ReadonlyMap<string, [OutPoint, VmTxOut]>,
        arkTxs: ReadonlyMap<string, [OutPoint, VmTx, number]>,
    ) {
        super();
        for (const [op, out] of prevOuts.values()) this.setPrevOut(op, out);
        for (const [op, tx, vout] of arkTxs.values()) {
            this.setArkTx(op, tx, vout);
            this.vouts.set(outpointKey(op), vout);
        }
    }

    prevOutIdx(op: OutPoint): number | undefined {
        return this.vouts.get(outpointKey(op));
    }

    fetchVtxoPrevOut(op: OutPoint): VmTxOut | undefined {
        const vout = this.prevOutIdx(op);
        return vout === undefined ? undefined : this.fetchPrevOutArkTx(op)?.outputs[vout];
    }
}

/** computePrevoutFetcher (utils.go:314-331): the witness utxos, later inputs winning. */
function witnessUtxos(ptx: Psbt): Map<string, [OutPoint, VmTxOut]> {
    const prevOuts = new Map<string, [OutPoint, VmTxOut]>();
    ptx.inputs.forEach((input, i) => {
        if (!input.witnessUtxo) throw new Error("witness utxo is nil");
        prevOuts.set(outpointKey(ptx.tx.inputs[i]), [ptx.tx.inputs[i], input.witnessUtxo]);
    });
    return prevOuts;
}

const PREV_ARK_TX = new Uint8Array([0xde, ...new TextEncoder().encode("prevarktx")]);
const PREVOUT_TX = new Uint8Array([0xde, ...new TextEncoder().encode("prevouttx")]);

/** decodePrevoutTxsFromField (utils.go:178-206): every input decodes before any is used. */
function prevoutTxs(ptx: Psbt, field: Uint8Array): (VmTx | undefined)[] {
    return ptx.inputs.map((input, i) => {
        const found = input.unknowns
            .filter((u) => equalBytes(u.key, field))
            .map((u) =>
                prefixed(`failed to decode prevout tx for input ${i}`, () => {
                    if (u.value.length > 1_000_000) {
                        throw new Error(
                            `max prevout tx length exceeded, max=1000000 got=${u.value.length}`,
                        );
                    }
                    return parseTx(u.value);
                }),
            );
        if (found.length > 1) throw new Error(`multiple prevout tx fields found for input ${i}`);
        return found[0];
    });
}

function validatePrevoutTx(i: number, prevTx: VmTx, expected: Uint8Array): void {
    const got = txid(prevTx);
    if (!equalBytes(got, expected)) {
        throw new Error(
            `prevout tx hash mismatch for input ${i}: got ${displayHash(got)}, expected ${displayHash(expected)}`,
        );
    }
}

function reconcilePrevout(
    i: number,
    prevTx: VmTx,
    vout: number,
    witnessUtxo: VmTxOut | undefined,
): void {
    if (!witnessUtxo) throw new Error(`witness utxo is nil for input ${i}`);
    const out = prevTx.outputs[vout];
    if (!out) {
        throw new Error(
            `prevout tx output index out of range for input ${i}: index=${vout} outputs=${prevTx.outputs.length}`,
        );
    }
    if (out.value !== witnessUtxo.value) {
        throw new Error(
            `prevout tx value mismatch for input ${i}: got ${witnessUtxo.value}, expected ${out.value}`,
        );
    }
    if (!equalBytes(out.script, witnessUtxo.script)) {
        throw new Error(
            `prevout tx script mismatch for input ${i}: got ${hex.encode(witnessUtxo.script)}, expected ${hex.encode(out.script)}`,
        );
    }
}

/** prevOutFetcherForProof (utils.go:18-64): input 0 is the BIP-322 message input. */
export function proofFetcher(ptx: Psbt): ArkTxFetcher {
    const prevOuts = witnessUtxos(ptx);
    const txs = prevoutTxs(ptx, PREV_ARK_TX);
    if (ptx.inputs.length < 2) throw new Error("proof must have at least 2 inputs");
    const expected = { value: 0n, script: (ptx.inputs[1].witnessUtxo as VmTxOut).script };
    if (!equalTxOut(ptx.inputs[0].witnessUtxo, expected)) {
        throw new Error("proof message input witness utxo is invalid");
    }
    const message = ptx.tx.inputs[0];
    const arkTxs = new Map<string, [OutPoint, VmTx, number]>([
        [
            outpointKey(message),
            [message, { version: 0, locktime: 0, inputs: [], outputs: [expected] }, 0],
        ],
    ]);
    for (let i = 1; i < ptx.inputs.length; i++) {
        const prevTx = txs[i];
        if (!prevTx) throw new Error(`missing prevout tx for input ${i}`);
        const op = ptx.tx.inputs[i];
        validatePrevoutTx(i, prevTx, op.txid);
        reconcilePrevout(i, prevTx, op.index, ptx.inputs[i].witnessUtxo);
        arkTxs.set(outpointKey(op), [op, prevTx, op.index]);
    }
    return new ArkTxFetcher(prevOuts, arkTxs);
}

/**
 * prevOutFetcherForArkTx (utils.go:67-135): the prevarktx field funds the checkpoint's input,
 * so the ark input's vtxo is the prev ark tx output at the checkpoint input's index.
 */
export function arkTxFetcher(ptx: Psbt, checkpoints: readonly (Psbt | null)[]): ArkTxFetcher {
    const prevOuts = witnessUtxos(ptx);
    const txs = prevoutTxs(ptx, PREV_ARK_TX);
    const byTxid = new Map<string, Psbt>();
    checkpoints.forEach((cp, i) => {
        if (!cp) throw new Error(`checkpoint ${i} is missing its transaction`);
        byTxid.set(hex.encode(txid(cp.tx)), cp);
    });
    const arkTxs = new Map<string, [OutPoint, VmTx, number]>();
    ptx.inputs.forEach((input, i) => {
        const prevTx = txs[i];
        if (!prevTx) throw new Error(`missing prevout tx for input ${i}`);
        const op = ptx.tx.inputs[i];
        const cp = byTxid.get(hex.encode(op.txid));
        if (!cp) throw new Error(`checkpoint not found for input ${i}`);
        if (cp.tx.inputs.length === 0) throw new Error(`checkpoint has no inputs for input ${i}`);
        if (cp.tx.inputs.length !== 1) {
            throw new Error(`checkpoint must have exactly one input for ark input ${i}`);
        }
        prefixed("ark input", () => reconcilePrevout(i, cp.tx, op.index, input.witnessUtxo));
        const funding = cp.tx.inputs[0];
        validatePrevoutTx(i, prevTx, funding.txid);
        reconcilePrevout(i, prevTx, funding.index, cp.inputs[0].witnessUtxo);
        arkTxs.set(outpointKey(op), [op, prevTx, funding.index]);
    });
    return new ArkTxFetcher(prevOuts, arkTxs);
}

/** prevOutFetcherForOnchainTx (utils.go:138-173), from the prevouttx field. */
export function onchainFetcher(ptx: Psbt): ArkTxFetcher {
    const prevOuts = witnessUtxos(ptx);
    const txs = prevoutTxs(ptx, PREVOUT_TX);
    const arkTxs = new Map<string, [OutPoint, VmTx, number]>();
    ptx.inputs.forEach((input, i) => {
        const prevTx = txs[i];
        if (!prevTx) throw new Error(`missing prevout tx for input ${i}`);
        const op = ptx.tx.inputs[i];
        validatePrevoutTx(i, prevTx, op.txid);
        reconcilePrevout(i, prevTx, op.index, input.witnessUtxo);
        arkTxs.set(outpointKey(op), [op, prevTx, op.index]);
    });
    return new ArkTxFetcher(prevOuts, arkTxs);
}

/** A template source as executor model.Source carries it; `tx` is the tx creating `outpoint`. */
export interface DraftSource {
    readonly outpoint: OutPoint;
    readonly amount: bigint;
    readonly tx?: VmTx;
}

/**
 * The executor's draft fetcher (draft.go:26-52, 105-111, 140-156). `sources` aligns with
 * `tx.inputs`, null for a proof's message input. An unbound source is invisible, and the message
 * input's prevout is source 1's pkScript at value 0.
 */
export function draftFetcher(
    tx: VmTx,
    sources: readonly (DraftSource | null)[],
): ArkPrevOutFetcher {
    const bound = sources.map((s) => {
        if (!s?.tx) return true;
        const out = s.tx.outputs[s.outpoint.index];
        return (
            out !== undefined &&
            equalBytes(txid(s.tx), s.outpoint.txid) &&
            out.value === BigInt.asIntN(64, s.amount)
        );
    });
    const source = (op: OutPoint): DraftSource | null | undefined => {
        const i = tx.inputs.findIndex((t) => t.index === op.index && equalBytes(t.txid, op.txid));
        return i < 0 || !bound[i] ? undefined : sources[i];
    };
    // Go leaves the pkScript nil without a source tx
    const pkScript = (s: DraftSource) => s.tx?.outputs[s.outpoint.index].script;
    const prevOut = (op: OutPoint): { value: bigint; script?: Uint8Array } | undefined => {
        const s = source(op);
        if (s === undefined) return undefined;
        if (s !== null) return { value: BigInt.asIntN(64, s.amount), script: pkScript(s) };
        const first = sources[1];
        return sources.length < 2 || !bound[1] || !first
            ? undefined
            : { value: 0n, script: pkScript(first) };
    };
    return {
        fetchPrevOutput: (op) => {
            const out = prevOut(op);
            return out && { value: out.value, script: out.script ?? new Uint8Array(0) };
        },
        fetchPrevOutArkTx: (op) => source(op)?.tx,
        fetchVtxoPrevOutPkScript: (op) => prevOut(op)?.script,
    };
}
