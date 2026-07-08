import { ChainTx, ChainTxType, IndexerProvider } from "../../providers/indexer";
import { OnchainProvider } from "../../providers/onchain";

export type DagNode = {
    txid: string;
    type: ChainTxType;
    expiresAt?: number;
    forVtxos: string[];
    confirmed: boolean;
};

const isCommitment = (t: ChainTxType) =>
    t === ChainTxType.COMMITMENT || t === ChainTxType.UNSPECIFIED;

/**
 * Merge the virtual-tx chains of several VTXOs into one deduplicated DAG.
 *
 * VTXOs under the same commitment share ancestor transactions; each shared
 * tx becomes a single node whose `forVtxos` lists every VTXO it serves, so
 * its fee is paid once. Nodes are returned in topological order (ancestors
 * first), commitments excluded (they are always onchain). `confirmed`
 * mirrors `Unroll.Session.next` semantics: a status lookup that throws
 * means "not onchain".
 */
export async function buildExitDag(params: {
    vtxos: { txid: string; vout: number }[];
    indexer: IndexerProvider;
    onchain: OnchainProvider;
}): Promise<DagNode[]> {
    const byTxid = new Map<string, ChainTx & { forVtxos: Set<string> }>();

    for (const vtxo of params.vtxos) {
        const { chain } = await params.indexer.getVtxoChain({
            txid: vtxo.txid,
            vout: vtxo.vout,
        });
        const outpoint = `${vtxo.txid}:${vtxo.vout}`;
        for (const chainTx of chain) {
            const existing = byTxid.get(chainTx.txid);
            if (existing) {
                existing.forVtxos.add(outpoint);
            } else {
                byTxid.set(chainTx.txid, { ...chainTx, forVtxos: new Set([outpoint]) });
            }
        }
    }

    // Kahn's algorithm over `spends` edges (parent -> child), commitments as
    // implicit satisfied roots.
    const pending = new Map(
        [...byTxid.values()].filter((tx) => !isCommitment(tx.type)).map((tx) => [tx.txid, tx]),
    );
    const inDegree = new Map<string, number>();
    for (const tx of pending.values()) {
        const parents = tx.spends.filter((p) => pending.has(p));
        inDegree.set(tx.txid, parents.length);
    }

    const order: (ChainTx & { forVtxos: Set<string> })[] = [];
    // deterministic order for tests and reproducible packages
    const queue = [...pending.values()]
        .filter((tx) => inDegree.get(tx.txid) === 0)
        .sort((a, b) => a.txid.localeCompare(b.txid));
    while (queue.length > 0) {
        const tx = queue.shift()!;
        order.push(tx);
        const children = [...pending.values()]
            .filter((c) => c.spends.includes(tx.txid))
            .sort((a, b) => a.txid.localeCompare(b.txid));
        for (const child of children) {
            const deg = inDegree.get(child.txid)! - 1;
            inDegree.set(child.txid, deg);
            if (deg === 0) queue.push(child);
        }
    }
    if (order.length !== pending.size) {
        throw new Error("inconsistent vtxo chain from indexer (cycle detected)");
    }

    const nodes: DagNode[] = [];
    for (const tx of order) {
        let confirmed = false;
        try {
            const status = await params.onchain.getTxStatus(tx.txid);
            confirmed = status.confirmed;
        } catch {
            confirmed = false; // not found => offchain
        }
        const expires = Number(tx.expiresAt);
        nodes.push({
            txid: tx.txid,
            type: tx.type,
            expiresAt: Number.isFinite(expires) && expires > 0 ? expires : undefined,
            forVtxos: [...tx.forVtxos].sort(),
            confirmed,
        });
    }
    return nodes;
}
