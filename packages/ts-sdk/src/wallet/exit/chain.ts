import { DEFAULT_PAGE_SIZE } from "../../contracts/constants";
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
        const outpoint = `${vtxo.txid}:${vtxo.vout}`;
        // The chain endpoint is paginated; a deep chain can span pages, so walk
        // them all — a short page (or absent page metadata) means end of history.
        let pageIndex = 0;
        let hasMore = true;
        while (hasMore) {
            const { chain, page } = await params.indexer.getVtxoChain(
                { txid: vtxo.txid, vout: vtxo.vout },
                { pageIndex, pageSize: DEFAULT_PAGE_SIZE },
            );
            for (const chainTx of chain) {
                const existing = byTxid.get(chainTx.txid);
                if (existing) {
                    existing.forVtxos.add(outpoint);
                } else {
                    byTxid.set(chainTx.txid, { ...chainTx, forVtxos: new Set([outpoint]) });
                }
            }
            hasMore = page ? chain.length === DEFAULT_PAGE_SIZE : false;
            pageIndex++;
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

/**
 * Order `items` so every dependency precedes its dependents. `depsOf` returns
 * the ids an item depends on; ids not produced by any item are treated as
 * already-satisfied roots (e.g. an already-onchain ancestor). Independent items
 * keep their incoming order, so output is deterministic. Throws on a cycle or an
 * unsatisfiable dependency.
 *
 * `buildExitDag` sorts by the indexer's *logical* vtxo chain, but the finalized
 * unroll txs' *physical* inputs can diverge (checkpoint spends), and the keyless
 * executor broadcasts those physical txs strictly in array order without
 * skipping ahead — so the steps must be re-sorted by their real inputs or a deep
 * chain deadlocks on the first step whose input is not yet onchain.
 */
export function topoSortByDeps<T>(
    items: T[],
    idOf: (t: T) => string,
    depsOf: (t: T) => string[],
): T[] {
    const produced = new Set(items.map(idOf));
    const emitted = new Set<string>();
    const ordered: T[] = [];
    let remaining = items;
    while (remaining.length > 0) {
        const next: T[] = [];
        let progress = false;
        for (const item of remaining) {
            if (depsOf(item).every((d) => !produced.has(d) || emitted.has(d))) {
                ordered.push(item);
                emitted.add(idOf(item));
                progress = true;
            } else {
                next.push(item);
            }
        }
        if (!progress) {
            throw new Error("topological sort: cycle or unsatisfiable dependency");
        }
        remaining = next;
    }
    return ordered;
}
