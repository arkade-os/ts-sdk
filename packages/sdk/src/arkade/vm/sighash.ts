import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import type { Engine } from "./engine";
import { KIND, plainError, prefixed } from "./errors";
import { serializeTxOut, taggedHash, type VmTxOut } from "./tx";

const SIGHASH_NONE = 0x02;
const SIGHASH_SINGLE = 0x03;
const SIGHASH_ANYONECANPAY = 0x80;
const SIGHASH_MASK = 0x1f;

/** BIP-341's set: 0x80, ANYONECANPAY over DEFAULT, is not in it. */
export const isValidTaprootSigHash = (t: number): boolean =>
    [0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83].includes(t);

interface MaskedTx {
    readonly out: VmTxOut | undefined;
    readonly idx: number;
    readonly outputsHash: Uint8Array;
    singleOutputHash?: Uint8Array;
}

// Go memoises this on the engine, whose tx is immutable and may weigh ~1 MB
const maskedTxs = new WeakMap<Engine, MaskedTx>();

// fail-open is the codec returning null; a throw is Go's re-encode error, not a parse failure
const maskExtensionOutput = (vm: Engine) =>
    prefixed(
        "arkade sha_outputs",
        () => vm.codecFor(vm.tx).maskExtensionOutput(vm.tx),
        (message) => plainError(KIND.sigHash, message),
    );

// sha_outputs over the tx with the emulator packet's witness blobs dropped
function maskedTx(vm: Engine): MaskedTx {
    const cached = maskedTxs.get(vm);
    if (cached) return cached;
    const masked = maskExtensionOutput(vm);
    const hash = sha256.create();
    vm.tx.outputs.forEach((o, i) => {
        hash.update(serializeTxOut(i === masked?.index ? masked.output : o));
    });
    const m: MaskedTx = {
        out: masked?.output,
        idx: masked?.index ?? -1,
        outputsHash: hash.digest(),
    };
    maskedTxs.set(vm, m);
    return m;
}

const u32 = (n: number): Uint8Array => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return b;
};

/** BIP-342's sigMsg, except for the masked outputs; spend_type is always 2 (no annex). */
export function buildArkadeSigMsg(vm: Engine, hashType: number): Uint8Array {
    const ctx = vm.taprootCtx;
    if (!ctx) {
        throw plainError(
            KIND.sigHash,
            "tapscript sighash requested outside of a tapscript execution context",
        );
    }
    if (!isValidTaprootSigHash(hashType)) {
        throw plainError(
            KIND.sigHash,
            `invalid taproot sighash type: 0x${hashType.toString(16).padStart(2, "0")}`,
        );
    }
    const { tx, txIdx: idx } = vm;
    const parts = [Uint8Array.of(0x00, hashType), u32(tx.version), u32(tx.locktime)];
    const anyoneCanPay = (hashType & SIGHASH_ANYONECANPAY) === SIGHASH_ANYONECANPAY;
    if (!anyoneCanPay) {
        const h = vm.sigHashes;
        if (!h) throw plainError(KIND.panic, "sighash midstates dereferenced while nil");
        parts.push(h.hashPrevOutsV1, h.hashInputAmountsV1, h.hashInputScriptsV1, h.hashSequenceV1);
    }
    const mode = hashType & SIGHASH_MASK;
    if (mode !== SIGHASH_SINGLE && mode !== SIGHASH_NONE) parts.push(maskedTx(vm).outputsHash);
    parts.push(Uint8Array.of(2));
    const input = tx.inputs[idx];
    if (anyoneCanPay) {
        const prevOut = vm.prevOutFetcher.fetchPrevOutput(input);
        if (!prevOut) throw plainError(KIND.sigHash, `no prevout for input ${idx}`);
        parts.push(input.txid, u32(input.index), serializeTxOut(prevOut), u32(input.sequence));
    } else {
        parts.push(u32(idx));
    }
    if (mode === SIGHASH_SINGLE) {
        if (idx >= tx.outputs.length) {
            throw plainError(KIND.sigHash, `SIGHASH_SINGLE: no output at input index ${idx}`);
        }
        const m = maskedTx(vm);
        const out = m.idx === idx && m.out ? m.out : tx.outputs[idx];
        m.singleOutputHash ??= sha256(serializeTxOut(out));
        parts.push(m.singleOutputHash);
    }
    parts.push(ctx.tapLeafHash, Uint8Array.of(0x00), u32(ctx.codeSepPos));
    return concatBytes(...parts);
}

/** The digest OP_CHECKSIG verifies and OP_SIGHASH pushes: tag "ArkadeTapSighash", not BIP-342's. */
export const computeArkadeSighash = (vm: Engine, hashType: number): Uint8Array =>
    taggedHash("ArkadeTapSighash", buildArkadeSigMsg(vm, hashType));
