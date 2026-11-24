import { hex } from "@scure/base";
import { equalBytes } from "@scure/btc-signer/utils.js";

import { vmExtensionCodec } from "../../../extension/vmCodec";
import {
    type ArkPrevOutFetcher,
    evalExpression,
    ExecutionError,
    KIND,
    type OutPoint,
    parseTx,
    ScriptError,
    serializeTx,
    txid,
    type VmTx,
} from "../../vm";
import { draftFetcher } from "../../vm/fetchers-ark";
import { assemble, checkScript, type Lookup } from "../asm";
import type { Input, TemplateType } from "../compile";
import type { Contract } from "../contract";
import { fail } from "../errors";

export interface Asset {
    /** 34 bytes. */
    id: Uint8Array;
    amount: bigint;
}

/** An output to spend; `tx` is the serialized transaction that created `txid:vout`. */
export interface Source {
    /** Display order, as block explorers show it. */
    txid: string;
    vout: number;
    tx: Uint8Array;
    amount: bigint;
    assets?: readonly Asset[];
    /** Unix seconds: when a virtual output expires. */
    expiry?: number;
    /** Unix seconds. */
    createdAt?: number;
    /** Offchain: swept by the server, hence recoverable. */
    swept?: boolean;
}

/** Go's model.Source; `tx` is absent only for a watch's placeholder. */
export interface Src {
    outpoint: OutPoint;
    tx?: VmTx;
    amount: bigint;
    assets: readonly Asset[];
    expiry?: number;
    createdAt?: number;
    swept: boolean;
}

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const UINT64 = (1n << 64n) - 1n;
const isUint64 = (n: unknown) => typeof n === "bigint" && n >= 0n && n <= UINT64;
const isSeconds = (n: unknown) =>
    n === undefined || (Number.isSafeInteger(n) && (n as number) >= 0);

/** A missing source or transaction stays undefined for checkSources to report, as Go does. */
export function toSrc(s: Source | undefined, i: number): Src | undefined {
    if (!s?.tx) return undefined;
    try {
        const txid = hex.decode(s.txid).reverse();
        if (txid.length !== 32) throw new Error(`txid of ${txid.length} bytes`);
        if (!Number.isInteger(s.vout) || s.vout < 0 || s.vout > 0xffffffff) {
            throw new Error(`vout ${s.vout} is not a uint32`);
        }
        const assets = (s.assets ?? []).map((a) => ({ id: a.id.slice(), amount: a.amount }));
        if (![s.amount, ...assets.map((a) => a.amount)].every(isUint64)) {
            throw new Error("amounts must be uint64");
        }
        if (!isSeconds(s.expiry) || !isSeconds(s.createdAt)) {
            throw new Error("expiry and createdAt must be whole non-negative seconds");
        }
        const tx = parseTx(s.tx);
        if (serializeTx(tx).length !== s.tx.length)
            throw new Error("trailing bytes after transaction");
        return {
            outpoint: { txid, index: s.vout },
            tx,
            amount: s.amount,
            assets,
            expiry: s.expiry,
            createdAt: s.createdAt,
            swept: s.swept ?? false,
        };
    } catch (e) {
        throw fail("ineligible", `source ${i}: ${messageOf(e)}`);
    }
}

export const placeholder = (): Src => ({
    outpoint: { txid: new Uint8Array(32), index: 0 },
    amount: 0n,
    assets: [],
    swept: false,
});

export const pkScriptOf = (s: Src): Uint8Array =>
    s.tx ? s.tx.outputs[s.outpoint.index].script : new Uint8Array();

/** Whether s.tx created s.outpoint holding s.amount. */
function isBound(s: Src): boolean {
    const out = s.tx?.outputs[s.outpoint.index];
    if (!s.tx) return true;
    return (
        out !== undefined &&
        equalBytes(txid(s.tx), s.outpoint.txid) &&
        out.value === BigInt.asIntN(64, s.amount)
    );
}

export function checkSources(sources: readonly (Src | undefined)[], n: number): void {
    if (sources.length !== n) throw fail("ineligible", `${sources.length} sources for ${n} inputs`);
    const spent = new Set<string>();
    sources.forEach((s, i) => {
        if (!s?.tx) throw fail("ineligible", `source ${i} or its transaction missing`);
        if (!isBound(s)) {
            throw fail("ineligible", `source ${i} is not the output of its transaction`);
        }
        const key = `${hex.encode(s.outpoint.txid)}:${s.outpoint.index}`;
        if (spent.has(key)) throw fail("ineligible", `source ${i} repeats an outpoint`);
        spent.add(key);
    });
}

export function checkSourceScript(input: Input, s: Src, ct: Contract): void {
    if (!equalBytes(pkScriptOf(s), ct.script.pkScript)) {
        throw fail(
            "ineligible",
            `input ${JSON.stringify(input.name)}: source script differs from the contract`,
        );
    }
}

/** The transaction expressions see: inputs at their final position, no output. */
export class Draft {
    contextFree = false;
    private readonly fetcher: ArkPrevOutFetcher;

    constructor(
        readonly tx: VmTx,
        /** Aligned with tx.inputs; null for a proof's message input. */
        readonly sources: readonly (Src | null)[],
    ) {
        this.fetcher = draftFetcher(tx, sources);
    }

    index(slot: number): number {
        return this.sources.length > 0 && this.sources[0] === null ? slot + 1 : slot;
    }

    evaluate(tokens: readonly string[], input: number, lookup: Lookup): Uint8Array {
        let script: Uint8Array;
        try {
            script = assemble(tokens, lookup);
            checkScript(script, this.contextFree);
        } catch (e) {
            throw fail("ineligible", `expression: ${messageOf(e)}`);
        }
        if (input < 0 || input >= this.sources.length) {
            throw fail("ineligible", `expression: input ${input} out of range`);
        }
        const src = this.sources[input];
        try {
            return evalExpression({
                script,
                tx: this.tx,
                inputIndex: input,
                inputAmount: src ? BigInt.asIntN(64, src.amount) : 0n,
                fetcher: this.fetcher,
                expiry: src?.expiry === undefined ? undefined : BigInt(src.expiry),
                codec: vmExtensionCodec,
            });
        } catch (e) {
            // anything else is a port gap or a bug, not a Go outcome
            if (!(e instanceof ScriptError || e instanceof ExecutionError)) throw e;
            if (e.kind === KIND.expressionStackDepth) throw fail("ineligible", e.message);
            // only the error code: a VM message can hold a sealed plaintext
            throw fail("ineligible", `expression: ${e.code ?? "script failed"}`);
        }
    }
}

/** Every sequence is final until `locks` sets the resolved ones, as Go's lock does in Build. */
export function newDraft(
    type: TemplateType,
    sources: readonly Src[],
    locks?: { locktime: number; sequences: readonly number[] },
): Draft {
    const all: (Src | null)[] = type === "proof" ? [null, ...sources] : [...sources];
    const first = all.length - sources.length;
    const inputs = all.map((s, k) => ({
        txid: s ? s.outpoint.txid : new Uint8Array(32),
        index: s ? s.outpoint.index : 0,
        scriptSig: new Uint8Array(),
        sequence: locks?.sequences[k - first] ?? 0xffffffff,
    }));
    const tx = {
        version: type === "virtual" ? 3 : 2,
        locktime: locks?.locktime ?? 0,
        inputs,
        outputs: [],
    };
    return new Draft(tx, all);
}
