import { Outpoint } from "../../wallet";
import {
    mergeChainedTxType,
    VirtualTx,
    VirtualTxRepository,
    VtxoBranch,
} from "../virtualTxRepository";

const opKey = (o: Outpoint) => `${o.txid}:${o.vout}`;

export class InMemoryVirtualTxRepository implements VirtualTxRepository {
    readonly version = 1 as const;
    private txs = new Map<string, VirtualTx>();
    private branches = new Map<string, VtxoBranch[]>();

    async clear(): Promise<void> {
        this.txs.clear();
        this.branches.clear();
    }

    async upsertVirtualTxs(txs: VirtualTx[]): Promise<void> {
        for (const t of txs) {
            const prev = this.txs.get(t.txid);
            if (!prev) {
                this.txs.set(t.txid, { ...t });
                continue;
            }
            this.txs.set(t.txid, {
                txid: t.txid,
                psbt: t.psbt ?? prev.psbt,
                expiresAt: t.expiresAt ?? prev.expiresAt,
                type: mergeChainedTxType(t.type, prev.type),
            });
        }
    }

    async getVirtualTx(txid: string): Promise<VirtualTx | null> {
        const t = this.txs.get(txid);
        return t ? { ...t } : null;
    }

    async setBranch(vtxo: Outpoint, branch: VtxoBranch[]): Promise<void> {
        this.branches.set(
            opKey(vtxo),
            [...branch].sort((a, b) => a.position - b.position),
        );
    }

    async getBranch(vtxo: Outpoint): Promise<VirtualTx[]> {
        const b = this.branches.get(opKey(vtxo)) ?? [];
        return b
            .map((x) => this.txs.get(x.virtualTxid))
            .filter((t): t is VirtualTx => !!t)
            .map((t) => ({ ...t }));
    }

    async hasBranch(vtxo: Outpoint): Promise<boolean> {
        return (this.branches.get(opKey(vtxo)) ?? []).length > 0;
    }

    async pruneForSpentVtxo(vtxo: Outpoint): Promise<void> {
        const removed = this.branches.get(opKey(vtxo)) ?? [];
        this.branches.delete(opKey(vtxo));
        const stillReferenced = new Set<string>();
        for (const b of this.branches.values())
            for (const e of b) stillReferenced.add(e.virtualTxid);
        for (const e of removed)
            if (!stillReferenced.has(e.virtualTxid)) this.txs.delete(e.virtualTxid);
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}
