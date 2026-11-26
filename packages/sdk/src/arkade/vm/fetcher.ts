import { hex } from "@scure/base";
import type { OutPoint, VmTx, VmTxOut } from "./tx";

/**
 * Every miss is `undefined`; what a miss means differs per call site, so never substitute. One
 * execution reads an outpoint more than once, as Go does, so each read must give the same answer.
 */
export interface ArkPrevOutFetcher {
    /** The output being spent: an ark tx output for intents, a checkpoint output for ark txs. */
    fetchPrevOutput(op: OutPoint): VmTxOut | undefined;
    /** The previous ark tx, even when a checkpoint sits in between. */
    fetchPrevOutArkTx(op: OutPoint): VmTx | undefined;
    fetchVtxoPrevOutPkScript(op: OutPoint): Uint8Array | undefined;
}

export const outpointKey = (op: OutPoint): string => `${hex.encode(op.txid)}:${op.index}`;

/** Go's mapArkPrevOutFetcher: a prevout map plus ark txs and the vout each outpoint spends. */
export class MapArkPrevOutFetcher implements ArkPrevOutFetcher {
    private readonly prevOuts = new Map<string, VmTxOut>();
    private readonly arkTxs = new Map<string, VmTx>();
    private readonly vtxoPkScripts = new Map<string, Uint8Array>();

    setPrevOut(op: OutPoint, out: VmTxOut): this {
        this.prevOuts.set(outpointKey(op), out);
        return this;
    }

    /** Sets the vtxo script only when `vout` names an output; never clears one already set. */
    setArkTx(op: OutPoint, tx: VmTx, vout?: number): this {
        this.arkTxs.set(outpointKey(op), tx);
        const out = vout === undefined ? undefined : tx.outputs[vout];
        if (out) this.vtxoPkScripts.set(outpointKey(op), out.script);
        return this;
    }

    setVtxoPkScript(op: OutPoint, script: Uint8Array): this {
        this.vtxoPkScripts.set(outpointKey(op), script);
        return this;
    }

    fetchPrevOutput(op: OutPoint): VmTxOut | undefined {
        return this.prevOuts.get(outpointKey(op));
    }

    fetchPrevOutArkTx(op: OutPoint): VmTx | undefined {
        return this.arkTxs.get(outpointKey(op));
    }

    fetchVtxoPrevOutPkScript(op: OutPoint): Uint8Array | undefined {
        return this.vtxoPkScripts.get(outpointKey(op));
    }
}
