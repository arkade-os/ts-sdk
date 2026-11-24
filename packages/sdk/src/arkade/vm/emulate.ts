import { equalBytes } from "@noble/curves/utils.js";
import { hex } from "@scure/base";
import { executeCovenant } from "./arkadeScript";
import { decodeClosure, parseControlBlock, verifyTaprootLeafCommitment } from "./closures";
import { codecFor, type TapLeaf } from "./engine";
import {
    ErrUnsupportedByPort,
    ExecutionError,
    messageOf,
    prefixed,
    ScriptError,
    wrap,
} from "./errors";
import {
    type ArkTxFetcher,
    arkTxFetcher,
    displayHash,
    equalTxOut,
    onchainFetcher,
    proofFetcher,
    type Psbt,
    type PsbtInput,
    readPsbt,
    type TapLeafScript,
} from "./fetchers-ark";
import {
    AggregateComputeLimits,
    ComputeBudget,
    type ComputeLimits,
    DefaultComputeLimits,
} from "./limits";
import { ScriptTokenizer } from "./tokenizer";
import {
    isPayToTaproot,
    type OutPoint,
    taggedHash,
    tapLeafHash,
    txid,
    type VmTx,
    type VmTxOut,
} from "./tx";
import type { EmulatorEntryLike, ExtensionCodec } from "./types";

/** emulator.SignRequest; `txid` is the displayed id of the PSBT holding the input to sign. */
export interface SignRequest {
    readonly txid: string;
    readonly inputIndex: number;
    readonly scriptHash: Uint8Array;
    /** x-only. */
    readonly closurePubKeys: Uint8Array[];
}

export interface ServiceOptions {
    /** The service's compute limits, applied exactly; DefaultComputeLimits() when absent. */
    readonly limits?: ComputeLimits;
    /** Reads the emulator and asset packets; without one, only a tx with no extension passes. */
    readonly codec?: ExtensionCodec;
}

/** OffchainData.VtxoExpiries, keyed `<displayed txid>:<vout>` like wire.OutPoint.String(). */
export type VtxoExpiries = ReadonlyMap<string, bigint>;

/** emulator.Error: `txid` is empty when the transaction is missing. */
export class EmulationError extends Error {
    constructor(
        readonly operation: string,
        readonly transactionKind: string,
        readonly txid: string,
        override readonly cause: unknown,
    ) {
        const field = transactionKind === "onchain" ? "txid" : `${transactionKind}_txid`;
        super(`${txid ? `${operation} ${field}=${txid}` : operation}: ${messageOf(cause)}`, {
            cause,
        });
        this.name = "EmulationError";
    }
}

const displayTxid = (tx: VmTx): string => displayHash(txid(tx));
const outPointString = (op: OutPoint): string => `${displayHash(op.txid)}:${op.index}`;
const byte = (n: number): string => n.toString(16).padStart(2, "0");

const BASE_LEAF_VERSION = 0xc0;
const OP_PUSHEXPIRY = 0xdb;
const ANCHOR: VmTxOut = { value: 0n, script: Uint8Array.of(0x51, 0x02, 0x4e, 0x73) };

interface ArkadeScript {
    readonly vin: number;
    readonly script: Uint8Array;
    readonly witness: readonly Uint8Array[];
    readonly hash: Uint8Array;
    readonly tapLeaf: TapLeaf;
    readonly closurePubKeys: Uint8Array[];
}

/** arkade.NewArkadeScript (script.go:136-186): no tweaked-key check, that is finalize's gate. */
function newArkadeScript(ptx: Psbt, entry: EmulatorEntryLike): ArkadeScript {
    const input = ptx.inputs[entry.vin];
    if (!input) throw new Error("input index out of range");
    const leaf = input.tapLeafScripts[0];
    if (!leaf) throw new Error("input does not specify any TaprootLeafScript");
    if (leaf.leafVersion !== BASE_LEAF_VERSION) {
        throw new Error(`unsupported taproot leaf version: 0x${byte(leaf.leafVersion)}`);
    }
    const closurePubKeys = prefixed("failed to decode tapscript", () => decodeClosure(leaf.script));
    return {
        vin: entry.vin,
        script: entry.script,
        witness: entry.witness,
        hash: taggedHash("ArkScriptHash", entry.script),
        tapLeaf: { leafVersion: leaf.leafVersion, script: leaf.script },
        closurePubKeys,
    };
}

/** txScripts + packetScripts (utils.go:339-367): every entry is read before any executes. */
function txScripts(ptx: Psbt, codec: ExtensionCodec | undefined): ArkadeScript[] {
    const packet = prefixed("failed to parse emulator packet", () =>
        codecFor(codec, ptx.tx).findEmulatorPacket(ptx.tx),
    );
    return (packet ?? []).map((entry) => {
        try {
            return newArkadeScript(ptx, entry);
        } catch (e) {
            throw new Error(`failed to read arkade script: ${messageOf(e)} vin=${entry.vin}`, {
                cause: e,
            });
        }
    });
}

/** indexCheckpoints (utils.go:422-455): one checkpoint per ark input, keyed by its txid. */
function indexCheckpoints(ark: Psbt, checkpoints: readonly (Psbt | null)[]): Map<string, Psbt> {
    if (checkpoints.length !== ark.tx.inputs.length) {
        throw new Error(`expected ${ark.tx.inputs.length} checkpoints, got ${checkpoints.length}`);
    }
    const indexed = new Map<string, Psbt>();
    checkpoints.forEach((cp, i) => {
        if (!cp) throw new Error(`checkpoint ${i} is missing its transaction`);
        const id = hex.encode(txid(cp.tx));
        if (indexed.has(id)) throw new Error(`duplicate checkpoint ${displayTxid(cp.tx)}`);
        indexed.set(id, cp);
    });
    const used = new Set<string>();
    ark.tx.inputs.forEach((input, i) => {
        const id = hex.encode(input.txid);
        if (!indexed.has(id)) throw new Error(`checkpoint not found for input ${i}`);
        if (used.has(id)) {
            throw new Error(
                `checkpoint ${displayHash(input.txid)} is associated with multiple ark inputs`,
            );
        }
        used.add(id);
    });
    return indexed;
}

/** validateTaprootLeaf (utils.go:505-529). */
function validateTaprootLeaf(input: PsbtInput, expected: TapLeaf): void {
    const utxo = input.witnessUtxo;
    if (!utxo || !isPayToTaproot(utxo.script)) throw new Error("witness utxo is not taproot");
    const leaf = input.tapLeafScripts[0];
    if (!leaf) throw new Error("missing taproot leaf script");
    const cb = prefixed("invalid control block", () => parseControlBlock(leaf.controlBlock));
    if (cb.leafVersion !== leaf.leafVersion) {
        throw new Error("control block leaf version does not match taproot leaf script");
    }
    const got = tapLeafHash(leaf.leafVersion, leaf.script);
    if (!equalBytes(got, tapLeafHash(expected.leafVersion, expected.script))) {
        throw new Error("tapleaf does not match ark input");
    }
    prefixed("tapleaf is not committed by witness utxo", () =>
        verifyTaprootLeafCommitment(cb, utxo.script.subarray(2), leaf.script),
    );
}

/** validateCheckpoint (utils.go:457-503); the fetcher has already reconciled most of it. */
function validateCheckpoint(
    ark: Psbt,
    i: number,
    cp: Psbt | undefined,
    previous: VmTxOut | undefined,
    leaf: TapLeaf,
): void {
    if (i < 0 || i >= ark.inputs.length) throw new Error("ark input index out of range");
    if (!cp || cp.tx.inputs.length !== 1) throw new Error("checkpoint must have exactly one input");
    if (cp.tx.outputs.length !== 2) {
        throw new Error("checkpoint must have one vtxo output and one anchor output");
    }
    const op = ark.tx.inputs[i];
    if (!equalBytes(op.txid, txid(cp.tx))) throw new Error("ark input does not spend checkpoint");
    if (op.index !== 0) throw new Error("ark input must spend checkpoint output 0");
    if (!equalTxOut(ark.inputs[i].witnessUtxo, cp.tx.outputs[0])) {
        throw new Error("checkpoint output does not match ark input witness utxo");
    }
    if (!equalTxOut(cp.tx.outputs[1], ANCHOR))
        throw new Error("checkpoint anchor output is invalid");
    if (!previous) throw new Error("missing authenticated previous ark output");
    if (!equalTxOut(cp.inputs[0].witnessUtxo, previous)) {
        throw new Error("checkpoint input witness utxo does not match previous ark transaction");
    }
    if (cp.tx.outputs[0].value !== previous.value) {
        throw new Error("checkpoint vtxo output value does not match its input");
    }
    prefixed("ark input tapleaf", () => validateTaprootLeaf(ark.inputs[i], leaf));
    prefixed("checkpoint tapleaf", () => validateTaprootLeaf(cp.inputs[0], leaf));
}

/** expiryForScript (utils.go:395-420): only a script with OP_PUSHEXPIRY needs one. */
function expiryForScript(script: Uint8Array, op: OutPoint, expiries: VtxoExpiries): bigint {
    const t = new ScriptTokenizer(script);
    while (t.next()) {
        if (t.op?.value !== OP_PUSHEXPIRY) continue;
        const at = expiries.get(outPointString(op));
        if (at === undefined) throw new Error(`vtxo ${outPointString(op)} not found`);
        if (at <= 0n) throw new Error(`vtxo ${outPointString(op)} has no expiry`);
        return at;
    }
    if (t.err) throw t.err;
    return 0n;
}

/** arkade.VerifyTaprootLeafCommitment (script.go:105-132). */
function verifyLeafCommitment(pkScript: Uint8Array, leaf: TapLeafScript): void {
    if (!isPayToTaproot(pkScript)) throw new Error("prevout script is not a taproot output");
    const cb = prefixed("failed to parse taproot control block", () =>
        parseControlBlock(leaf.controlBlock),
    );
    if (cb.leafVersion !== leaf.leafVersion) {
        throw new Error(
            `control block leaf version 0x${byte(cb.leafVersion)} does not match tapscript leaf version 0x${byte(leaf.leafVersion)}`,
        );
    }
    prefixed("taproot leaf script is not committed by the prevout script", () =>
        verifyTaprootLeafCommitment(cb, pkScript.subarray(2), leaf.script),
    );
}

/** newSignRequest (types.go:105-132). */
function newSignRequest(ptx: Psbt, i: number, s: ArkadeScript): SignRequest {
    const input = ptx.inputs[i];
    if (!input) throw new Error("input index out of range, cannot sign");
    if (!input.witnessUtxo || !isPayToTaproot(input.witnessUtxo.script)) {
        throw new Error("not a taproot input, cannot sign");
    }
    const leaves = input.tapLeafScripts;
    if (leaves.length !== 1) {
        throw new Error(
            `expected exactly 1 taproot leaf script, got ${leaves.length}, cannot sign`,
        );
    }
    prefixed("cannot sign input", () => verifyLeafCommitment(input.witnessUtxo!.script, leaves[0]));
    return {
        txid: displayTxid(ptx.tx),
        inputIndex: i,
        scriptHash: s.hash.slice(),
        closurePubKeys: s.closurePubKeys.map((k) => k.slice()),
    };
}

type ExecuteOptions = ReturnType<typeof executeOptions> & {
    expiry?: bigint;
    intentMessage?: string;
};

/**
 * ArkadeScript.Execute's wrapping: only a located failure comes from running the script, and
 * NewEngine is the only other step that fails with a code (the shell words the rest as Go does).
 */
function execute(s: ArkadeScript, tx: VmTx, fetcher: ArkTxFetcher, opts: ExecuteOptions): void {
    try {
        const { script, tapLeaf, witness, vin: inputIndex } = s;
        executeCovenant({ ...opts, script, tapLeaf, witness, tx, inputIndex, fetcher });
    } catch (e) {
        const phase =
            e instanceof ExecutionError
                ? "failed to execute arkade script"
                : e instanceof ScriptError && e.code !== undefined
                  ? "failed to create engine"
                  : undefined;
        throw wrap(`input ${s.vin}`, phase ? wrap(phase, e) : e);
    }
}

/** executeOptions (service.go:272-277): one budget is shared by every input of the request. */
function executeOptions(limits: ComputeLimits = DefaultComputeLimits(), codec?: ExtensionCodec) {
    return { limits, budget: new ComputeBudget(AggregateComputeLimits(limits)), codec };
}

function service(
    operation: string,
    kind: string,
    raw: Uint8Array,
    body: (ptx: Psbt) => SignRequest[],
): SignRequest[] {
    if (raw.length === 0)
        throw new EmulationError(operation, kind, "", new Error("missing transaction"));
    const ptx = readPsbt(raw);
    try {
        return body(ptx);
    } catch (e) {
        if (e instanceof ErrUnsupportedByPort) throw e;
        throw new EmulationError(operation, kind, displayTxid(ptx.tx), e);
    }
}

/**
 * EmulateOffchainTx (service.go:31-101): runs every emulator packet entry on the ark tx and
 * returns, per entry, the ark input and its checkpoint's input 0 to sign. An empty PSBT is Go's
 * nil transaction; an empty checkpoint, a nil checkpoint.
 */
export function emulateOffchainTx(
    o: ServiceOptions & {
        arkPsbt: Uint8Array;
        checkpoints: readonly Uint8Array[];
        vtxoExpiries: VtxoExpiries;
    },
): SignRequest[] {
    const checkpoints = o.checkpoints.map((b) => (b.length === 0 ? null : readPsbt(b)));
    return service("emulate offchain tx", "ark", o.arkPsbt, (ark) => {
        const scripts = txScripts(ark, o.codec);
        if (scripts.length === 0) return [];
        const indexed = indexCheckpoints(ark, checkpoints);
        const fetcher = prefixed("failed to create prevout fetcher", () =>
            arkTxFetcher(ark, checkpoints),
        );
        const opts = executeOptions(o.limits, o.codec);
        return scripts.flatMap((s) => {
            const op = ark.tx.inputs[s.vin];
            const cpTxid = displayHash(op.txid);
            const cp = indexed.get(hex.encode(op.txid));
            prefixed(`invalid checkpoint for ark input ${s.vin} checkpoint_txid=${cpTxid}`, () =>
                validateCheckpoint(ark, s.vin, cp, fetcher.fetchVtxoPrevOut(op), s.tapLeaf),
            );
            const prevArkTx = fetcher.fetchPrevOutArkTx(op);
            if (!prevArkTx) throw new Error(`prevout ark tx not found for input ${s.vin}`);
            const vtxo = { txid: txid(prevArkTx), index: fetcher.prevOutIdx(op) ?? 0 };
            const expiry = prefixed(`input ${s.vin}: expiry`, () =>
                expiryForScript(s.script, vtxo, o.vtxoExpiries),
            );
            execute(s, ark.tx, fetcher, { ...opts, expiry });
            const arkReq = prefixed(`cannot request signature for input ${s.vin}`, () =>
                newSignRequest(ark, s.vin, s),
            );
            const cpReq = prefixed(
                `cannot request signature for checkpoint input 0 (checkpoint_txid=${cpTxid}, ark input ${s.vin})`,
                () => newSignRequest(cp as Psbt, 0, s),
            );
            return [arkReq, cpReq];
        });
    });
}

/**
 * EmulateBatchRegistration (service.go:146-215): input 0 is the proof's message input, approved
 * with input 1 under input 1's script and never executed on its own.
 */
export function emulateBatchRegistration(
    o: ServiceOptions & { proofPsbt: Uint8Array; message: string; vtxoExpiries: VtxoExpiries },
): SignRequest[] {
    return service("emulate batch registration", "proof", o.proofPsbt, (ptx) => {
        const scripts = txScripts(ptx, o.codec);
        if (scripts.length === 0) return [];
        const fetcher = prefixed("failed to create prevout fetcher", () => proofFetcher(ptx));
        const run = scripts.filter((s) => s.vin !== 0);
        if (run.length === 0) throw new Error("no input to execute");
        const opts = executeOptions(o.limits, o.codec);
        return run.flatMap((s) => {
            const expiry = prefixed(`input ${s.vin}: expiry`, () =>
                expiryForScript(s.script, ptx.tx.inputs[s.vin], o.vtxoExpiries),
            );
            execute(s, ptx.tx, fetcher, { ...opts, intentMessage: o.message, expiry });
            const req = prefixed(`cannot request signature for input ${s.vin}`, () =>
                newSignRequest(ptx, s.vin, s),
            );
            if (s.vin !== 1) return [req];
            const [message, first] = ptx.inputs;
            if (!equalBytes(message.witnessUtxo!.script, first.witnessUtxo!.script)) {
                throw new Error("message input script does not match input 1 script");
            }
            return [
                req,
                prefixed("cannot request signature for message input", () =>
                    newSignRequest(ptx, 0, s),
                ),
            ];
        });
    });
}

/** EmulateOnchainTx (service.go:104-143): no expiry, one request per entry. */
export function emulateOnchainTx(o: ServiceOptions & { psbt: Uint8Array }): SignRequest[] {
    return service("emulate onchain tx", "onchain", o.psbt, (ptx) => {
        const scripts = txScripts(ptx, o.codec);
        if (scripts.length === 0) return [];
        const fetcher = prefixed("failed to create prevout fetcher", () => onchainFetcher(ptx));
        const opts = executeOptions(o.limits, o.codec);
        return scripts.map((s) => {
            execute(s, ptx.tx, fetcher, opts);
            return prefixed(`cannot request signature for input ${s.vin}`, () =>
                newSignRequest(ptx, s.vin, s),
            );
        });
    });
}
