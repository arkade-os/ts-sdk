import { base64, hex } from "@scure/base";
import { ChainTx, ChainTxType } from "../../providers/indexer";
import { ChainedTxType, VirtualTxRepository } from "../../repositories/virtualTxRepository";
import { Transaction } from "../../utils/transaction";
import { Outpoint } from "../index";
import { ExitDataSource } from "./resolver";

/** Reverse of `chainTxTypeToChainedExit` (unroll.ts:27): numeric repo enum → indexer string enum. */
export function chainedTxTypeToChainTxType(t: ChainedTxType): ChainTxType {
    switch (t) {
        case ChainedTxType.Commitment:
            return ChainTxType.COMMITMENT;
        case ChainedTxType.Ark:
            return ChainTxType.ARK;
        case ChainedTxType.Tree:
            return ChainTxType.TREE;
        case ChainedTxType.Checkpoint:
            return ChainTxType.CHECKPOINT;
        default:
            return ChainTxType.UNSPECIFIED;
    }
}

/** Prevout txids (display order) of every input of a base64 PSBT — the physical `spends`. */
export function psbtInputTxids(psbtBase64: string): string[] {
    const tx = Transaction.fromPSBT(base64.decode(psbtBase64));
    const ids: string[] = [];
    for (let i = 0; i < tx.inputsLength; i++) {
        const txid = tx.getInput(i).txid;
        if (txid) ids.push(hex.encode(txid));
    }
    return ids;
}

/**
 * Exit-data source backed by the local `VirtualTxRepository`. Full data (PSBTs
 * present) yields a full chain with physical `spends`; Lite (a non-commitment
 * tx lacking a PSBT) is a structure miss, so the resolver falls to the indexer.
 */
export class RepositoryExitDataSource implements ExitDataSource {
    readonly name = "repository";

    constructor(private readonly repo: VirtualTxRepository) {}

    async getVtxoChain(vtxo: Outpoint): Promise<ChainTx[] | null> {
        const branch = await this.repo.getBranch(vtxo);
        if (branch.length === 0) return null;
        const chain: ChainTx[] = [];
        for (const v of branch) {
            const type = chainedTxTypeToChainTxType(v.type);
            let spends: string[] = [];
            if (v.type !== ChainedTxType.Commitment) {
                if (!v.psbt) return null; // Lite / structure unavailable
                spends = psbtInputTxids(v.psbt);
            }
            chain.push({
                txid: v.txid,
                type,
                expiresAt: v.expiresAt != null ? String(v.expiresAt) : "",
                spends,
            });
        }
        return chain;
    }

    async getVirtualTxs(txids: string[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        for (const txid of txids) {
            const stored = await this.repo.getVirtualTx(txid);
            if (stored?.psbt) out.set(txid, stored.psbt);
        }
        return out;
    }
}
