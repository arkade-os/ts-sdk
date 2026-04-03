import { describe, it, expect, vi } from "vitest";
import {
    buildVtxoDAG,
    renderDAGAscii,
} from "../../src/verification/dagVisualizer";
import type { VtxoDAG } from "../../src/verification/dagVisualizer";
import type { IndexerProvider } from "../../src/providers/indexer";
import type { VirtualCoin } from "../../src/wallet";

describe("buildVtxoDAG", () => {
    it("should build a DAG with nodes and edges from chain", async () => {
        const vtxo = makeVtxo("aa".repeat(32));
        const mockIndexer = makeMockIndexer([
            {
                txid: "cc".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                expiresAt: "",
                spends: [],
            },
            {
                txid: "bb".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_TREE",
                expiresAt: "",
                spends: ["cc".repeat(32)],
            },
        ]);

        const dag = await buildVtxoDAG(vtxo, mockIndexer);

        expect(dag.vtxoOutpoint.txid).toBe(vtxo.txid);
        expect(dag.nodes.length).toBeGreaterThanOrEqual(2);
        expect(dag.commitmentTxids).toContain("cc".repeat(32));
        expect(dag.edges.length).toBeGreaterThan(0);
    });

    it("should place checkpoints on edges, not as nodes", async () => {
        const vtxo = makeVtxo("aa".repeat(32));
        const mockIndexer = makeMockIndexer([
            {
                txid: "cc".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                expiresAt: "",
                spends: [],
            },
            {
                txid: "bb".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_TREE",
                expiresAt: "",
                spends: ["cc".repeat(32)],
            },
            {
                txid: "cp".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_CHECKPOINT",
                expiresAt: "2026-12-31T00:00:00Z",
                spends: ["bb".repeat(32)],
            },
        ]);

        const dag = await buildVtxoDAG(vtxo, mockIndexer);

        // Checkpoint should NOT be a node
        expect(
            dag.nodes.find((n) => n.txid === "cp".repeat(32))
        ).toBeUndefined();

        // Checkpoint should be on an edge
        const edgeWithCheckpoint = dag.edges.find((e) => e.checkpoint);
        expect(edgeWithCheckpoint).toBeDefined();
        expect(edgeWithCheckpoint!.checkpoint!.txid).toBe("cp".repeat(32));
    });

    it("should handle multiple commitment txs", async () => {
        const vtxo = makeVtxo("aa".repeat(32));
        const mockIndexer = makeMockIndexer([
            {
                txid: "c1".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                expiresAt: "",
                spends: [],
            },
            {
                txid: "c2".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                expiresAt: "",
                spends: [],
            },
            {
                txid: "bb".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_TREE",
                expiresAt: "",
                spends: ["c1".repeat(32)],
            },
        ]);

        const dag = await buildVtxoDAG(vtxo, mockIndexer);

        expect(dag.commitmentTxids).toHaveLength(2);
        expect(dag.commitmentTxids).toContain("c1".repeat(32));
        expect(dag.commitmentTxids).toContain("c2".repeat(32));
    });

    it("should include ARK type as ark nodes", async () => {
        const vtxo = makeVtxo("aa".repeat(32));
        const mockIndexer = makeMockIndexer([
            {
                txid: "cc".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                expiresAt: "",
                spends: [],
            },
            {
                txid: "tt".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_TREE",
                expiresAt: "",
                spends: ["cc".repeat(32)],
            },
            {
                txid: "ak".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_ARK",
                expiresAt: "",
                spends: ["tt".repeat(32)],
            },
        ]);

        const dag = await buildVtxoDAG(vtxo, mockIndexer);

        const arkNode = dag.nodes.find((n) => n.txid === "ak".repeat(32));
        expect(arkNode).toBeDefined();
        expect(arkNode!.type).toBe("ark");
    });

    it("should return empty edges for chain with only commitment", async () => {
        const vtxo = makeVtxo("aa".repeat(32));
        const mockIndexer = makeMockIndexer([
            {
                txid: "cc".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                expiresAt: "",
                spends: [],
            },
        ]);

        const dag = await buildVtxoDAG(vtxo, mockIndexer);

        expect(dag.commitmentTxids).toHaveLength(1);
        expect(dag.edges).toHaveLength(0);
    });
});

describe("renderDAGAscii", () => {
    it("should render a readable ASCII tree", () => {
        const dag: VtxoDAG = {
            vtxoOutpoint: { txid: "aa".repeat(32), vout: 0 },
            nodes: [
                { txid: "aa".repeat(32), type: "vtxo", amount: 10000 },
                { txid: "bb".repeat(32), type: "tree" },
                { txid: "cc".repeat(32), type: "commitment" },
            ],
            edges: [
                { from: "bb".repeat(32), to: "aa".repeat(32) },
                { from: "cc".repeat(32), to: "bb".repeat(32) },
            ],
            commitmentTxids: ["cc".repeat(32)],
        };

        const ascii = renderDAGAscii(dag);

        expect(ascii).toContain("[VTXO]");
        expect(ascii).toContain("[TREE]");
        expect(ascii).toContain("[COMMITMENT]");
        expect(ascii).toContain("10000 sats");
    });

    it("should show checkpoint on edge", () => {
        const dag: VtxoDAG = {
            vtxoOutpoint: { txid: "aa".repeat(32), vout: 0 },
            nodes: [
                { txid: "aa".repeat(32), type: "vtxo" },
                { txid: "cc".repeat(32), type: "commitment" },
            ],
            edges: [
                {
                    from: "cc".repeat(32),
                    to: "aa".repeat(32),
                    checkpoint: { txid: "cpcp".repeat(8) },
                },
            ],
            commitmentTxids: ["cc".repeat(32)],
        };

        const ascii = renderDAGAscii(dag);

        expect(ascii).toContain("checkpoint");
    });
});

// ============================================================
// Test helpers
// ============================================================

function makeVtxo(txid: string): VirtualCoin {
    return {
        txid,
        vout: 0,
        value: 10_000n,
        virtualStatus: {
            state: "confirmed",
            batchTxid: "",
            commitmentTxIds: [],
        },
    } as VirtualCoin;
}

function makeMockIndexer(chain: any[]): IndexerProvider {
    return {
        getVtxoChain: vi.fn().mockResolvedValue({ chain }),
        getVtxoTree: vi.fn(),
        getVirtualTxs: vi.fn(),
        getVtxoTreeLeaves: vi.fn(),
        getBatchSweepTransactions: vi.fn(),
        getCommitmentTx: vi.fn(),
        getCommitmentTxConnectors: vi.fn(),
        getCommitmentTxForfeitTxs: vi.fn(),
        getSubscription: vi.fn(),
        getVtxos: vi.fn(),
        getAssetDetails: vi.fn(),
        subscribeForScripts: vi.fn(),
        unsubscribeForScripts: vi.fn(),
    } as IndexerProvider;
}
