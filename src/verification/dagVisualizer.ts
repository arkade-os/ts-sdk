import type { Outpoint, VirtualCoin } from "../wallet";
import type { IndexerProvider, ChainTx } from "../providers/indexer";
import { ChainTxType } from "../providers/indexer";

export interface DAGNode {
    txid: string;
    type: "vtxo" | "tree" | "ark" | "commitment";
    /** Amount in sats (if known from the chain entry) */
    amount?: number;
    /** Expiry timestamp (ISO string, if set) */
    expiresAt?: string;
    /** For commitment nodes: whether confirmed onchain */
    confirmed?: boolean;
}

export interface DAGEdge {
    from: string; // parent txid
    to: string; // child txid
    /** Output index on the parent that this edge represents */
    outputIndex?: number;
    /** Checkpoint data attached to this edge (if a checkpoint tx sits between parent and child) */
    checkpoint?: {
        txid: string;
        expiresAt?: string;
    };
}

export interface VtxoDAG {
    /** The VTXO this DAG was built for */
    vtxoOutpoint: Outpoint;
    /** All nodes in the DAG */
    nodes: DAGNode[];
    /** Edges connecting nodes (parent → child direction, backward in time) */
    edges: DAGEdge[];
    /** Commitment transactions (the onchain leaves of the DAG) */
    commitmentTxids: string[];
}

/**
 * Builds a structured DAG representation of a VTXO's virtual history.
 *
 * The DAG starts at the VTXO (root, most recent) and traces backward
 * through intermediate virtual transactions to the commitment tx(s)
 * (leaves, oldest, anchored onchain).
 *
 * Checkpoint transactions are not displayed as nodes — they are
 * attached as metadata on the edges they sit between.
 */
export async function buildVtxoDAG(
    vtxo: VirtualCoin,
    indexer: IndexerProvider
): Promise<VtxoDAG> {
    const outpoint: Outpoint = { txid: vtxo.txid, vout: vtxo.vout };

    const { chain } = await indexer.getVtxoChain(outpoint);

    const nodes: DAGNode[] = [];
    const edges: DAGEdge[] = [];
    const commitmentTxids: string[] = [];
    const checkpointsBySpend = new Map<
        string,
        { txid: string; expiresAt?: string }
    >();

    // First pass: collect checkpoints and index by their parent (spends[0])
    for (const entry of chain) {
        if (entry.type === ChainTxType.CHECKPOINT) {
            const parent = entry.spends?.[0];
            if (parent) {
                checkpointsBySpend.set(parent, {
                    txid: entry.txid,
                    expiresAt: entry.expiresAt || undefined,
                });
            }
        }
    }

    // Second pass: build nodes and edges
    for (const entry of chain) {
        if (entry.type === ChainTxType.CHECKPOINT) {
            continue; // checkpoints are edge metadata, not nodes
        }

        const nodeType = chainTxTypeToNodeType(entry.type);

        nodes.push({
            txid: entry.txid,
            type: nodeType,
            expiresAt: entry.expiresAt || undefined,
        });

        if (nodeType === "commitment") {
            commitmentTxids.push(entry.txid);
        }

        // Build edges from this tx to its parents (spends)
        for (const parentTxid of entry.spends ?? []) {
            const edge: DAGEdge = {
                from: parentTxid,
                to: entry.txid,
            };

            // Attach checkpoint if one sits on this edge
            const checkpoint = checkpointsBySpend.get(entry.txid);
            if (checkpoint) {
                edge.checkpoint = checkpoint;
            }

            edges.push(edge);
        }
    }

    // Add the VTXO itself as the root node if not already in the chain
    if (!nodes.some((n) => n.txid === vtxo.txid)) {
        nodes.unshift({
            txid: vtxo.txid,
            type: "vtxo",
            amount:
                typeof vtxo.value === "bigint"
                    ? Number(vtxo.value)
                    : Number(vtxo.value),
        });
    }

    return {
        vtxoOutpoint: outpoint,
        nodes,
        edges,
        commitmentTxids,
    };
}

function chainTxTypeToNodeType(type: ChainTxType): DAGNode["type"] {
    switch (type) {
        case ChainTxType.COMMITMENT:
            return "commitment";
        case ChainTxType.ARK:
            return "ark";
        case ChainTxType.TREE:
            return "tree";
        default:
            return "tree";
    }
}

/**
 * Renders the DAG as a simple ASCII tree for CLI/debug output.
 */
export function renderDAGAscii(dag: VtxoDAG): string {
    const lines: string[] = [];
    const nodeMap = new Map(dag.nodes.map((n) => [n.txid, n]));

    // Root = VTXO (not a "from" in any edge, i.e. has no children pointing to it)
    const parentTxids = new Set(dag.edges.map((e) => e.from));
    const roots = dag.nodes.filter((n) => !parentTxids.has(n.txid));

    // If no roots found (shouldn't happen), use first node
    if (roots.length === 0 && dag.nodes.length > 0) {
        roots.push(dag.nodes[0]);
    }

    function render(txid: string, prefix: string, isLast: boolean) {
        const node = nodeMap.get(txid);
        if (!node) return;

        const connector = isLast ? "└─" : "├─";
        lines.push(`${prefix}${connector} ${formatNode(node)}`);

        const childPrefix = prefix + (isLast ? "   " : "│  ");

        // Find edges where this node is the "to" (going backward to parents)
        const parentEdges = dag.edges.filter((e) => e.to === txid);

        parentEdges.forEach((edge, i) => {
            if (edge.checkpoint) {
                lines.push(
                    `${childPrefix}│  [checkpoint: ${edge.checkpoint.txid.slice(0, 8)}...]`
                );
            }
            render(edge.from, childPrefix, i === parentEdges.length - 1);
        });
    }

    for (const root of roots) {
        lines.push(formatNode(root));
        const parentEdges = dag.edges.filter((e) => e.to === root.txid);
        parentEdges.forEach((edge, i) => {
            if (edge.checkpoint) {
                lines.push(
                    `  │  [checkpoint: ${edge.checkpoint.txid.slice(0, 8)}...]`
                );
            }
            render(edge.from, "", i === parentEdges.length - 1);
        });
    }

    return lines.join("\n");
}

function formatNode(node: DAGNode): string {
    const short = node.txid.slice(0, 12) + "...";
    const amount = node.amount ? ` (${node.amount} sats)` : "";
    const tag = `[${node.type.toUpperCase()}]`;
    return `${tag} ${short}${amount}`;
}
