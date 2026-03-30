import { describe, it, expect, vi } from "vitest";
import { verifyVtxo } from "../../src/verification/vtxoChainVerifier";
import type { VirtualCoin } from "../../src/wallet";
import type { IndexerProvider, ChainTxType } from "../../src/providers/indexer";
import type { OnchainProvider } from "../../src/providers/onchain";

function createMockVtxo(overrides: Partial<VirtualCoin> = {}): VirtualCoin {
    return {
        txid: "a".repeat(64),
        vout: 0,
        value: 10000,
        status: { confirmed: true, isLeaf: true },
        virtualStatus: {
            state: "settled",
            commitmentTxIds: ["c".repeat(64)],
            batchExpiry: Date.now() + 86400000,
        },
        spentBy: "",
        createdAt: new Date(),
        isUnrolled: false,
        isSpent: false,
        ...overrides,
    };
}

function createMockIndexer(
    overrides: Partial<IndexerProvider> = {}
): IndexerProvider {
    return {
        getVtxoTree: vi
            .fn()
            .mockResolvedValue({ vtxoTree: [], page: undefined }),
        getVtxoTreeLeaves: vi.fn().mockResolvedValue({ leaves: [] }),
        getBatchSweepTransactions: vi.fn().mockResolvedValue({ sweptBy: [] }),
        getCommitmentTx: vi.fn(),
        getCommitmentTxConnectors: vi
            .fn()
            .mockResolvedValue({ connectors: [] }),
        getCommitmentTxForfeitTxs: vi.fn().mockResolvedValue({ txids: [] }),
        getSubscription: vi.fn(),
        getVirtualTxs: vi.fn().mockResolvedValue({ txs: [] }),
        getVtxoChain: vi.fn().mockResolvedValue({ chain: [] }),
        getVtxos: vi.fn().mockResolvedValue({ vtxos: [] }),
        getAssetDetails: vi.fn(),
        subscribeForScripts: vi.fn(),
        unsubscribeForScripts: vi.fn(),
        ...overrides,
    };
}

function createMockOnchain(
    overrides: Partial<OnchainProvider> = {}
): OnchainProvider {
    return {
        getCoins: vi.fn(),
        getFeeRate: vi.fn(),
        broadcastTransaction: vi.fn(),
        getTxOutspends: vi.fn().mockResolvedValue([]),
        getTransactions: vi.fn(),
        getTxStatus: vi.fn().mockResolvedValue({
            confirmed: true,
            blockHeight: 100,
            blockTime: 1700000000,
        }),
        getTxHex: vi.fn(),
        getChainTip: vi.fn().mockResolvedValue({
            height: 110,
            time: 1700001000,
            hash: "0".repeat(64),
        }),
        watchAddresses: vi.fn(),
        ...overrides,
    };
}

const serverInfo = {
    pubkey: new Uint8Array(32).fill(0x02),
    sweepInterval: { type: "blocks" as const, value: 144n },
};

describe("verifyVtxo", () => {
    it("should return error for preconfirmed VTXO", async () => {
        const vtxo = createMockVtxo({
            virtualStatus: {
                state: "preconfirmed",
                commitmentTxIds: [],
            },
        });

        const result = await verifyVtxo(
            vtxo,
            createMockIndexer(),
            createMockOnchain(),
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
            "VTXO is preconfirmed and has no commitment transaction yet"
        );
    });

    it("should return error for empty chain", async () => {
        const vtxo = createMockVtxo();
        const indexer = createMockIndexer({
            getVtxoChain: vi.fn().mockResolvedValue({ chain: [] }),
        });

        const result = await verifyVtxo(
            vtxo,
            indexer,
            createMockOnchain(),
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
            "Empty VTXO chain returned from indexer"
        );
    });

    it("should return error when indexer getVtxoChain fails", async () => {
        const vtxo = createMockVtxo();
        const indexer = createMockIndexer({
            getVtxoChain: vi
                .fn()
                .mockRejectedValue(new Error("Connection refused")),
        });

        const result = await verifyVtxo(
            vtxo,
            indexer,
            createMockOnchain(),
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e) => e.includes("Failed to fetch VTXO chain"))
        ).toBe(true);
    });

    it("should return error when no commitment tx in chain", async () => {
        const vtxo = createMockVtxo();
        const indexer = createMockIndexer({
            getVtxoChain: vi.fn().mockResolvedValue({
                chain: [
                    {
                        txid: "d".repeat(64),
                        expiresAt: "1700000000",
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        spends: [],
                    },
                ],
            }),
        });

        const result = await verifyVtxo(
            vtxo,
            indexer,
            createMockOnchain(),
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e) =>
                e.includes("No commitment transaction found")
            )
        ).toBe(true);
    });

    it("should return error when VTXO has no commitment tx IDs", async () => {
        const vtxo = createMockVtxo({
            virtualStatus: {
                state: "settled",
                commitmentTxIds: [],
            },
        });

        const indexer = createMockIndexer({
            getVtxoChain: vi.fn().mockResolvedValue({
                chain: [
                    {
                        txid: "c".repeat(64),
                        expiresAt: "1700000000",
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        spends: [],
                    },
                ],
            }),
        });

        const result = await verifyVtxo(
            vtxo,
            indexer,
            createMockOnchain(),
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e) => e.includes("no commitment tx IDs"))
        ).toBe(true);
    });

    it("should return error when VTXO tree is empty", async () => {
        const vtxo = createMockVtxo();

        const indexer = createMockIndexer({
            getVtxoChain: vi.fn().mockResolvedValue({
                chain: [
                    {
                        txid: "c".repeat(64),
                        expiresAt: "1700000000",
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        spends: [],
                    },
                    {
                        txid: "d".repeat(64),
                        expiresAt: "1700000000",
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        spends: [],
                    },
                ],
            }),
            getVtxoTree: vi
                .fn()
                .mockResolvedValue({ vtxoTree: [], page: undefined }),
        });

        const result = await verifyVtxo(
            vtxo,
            indexer,
            createMockOnchain(),
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes("Empty VTXO tree"))).toBe(
            true
        );
    });

    it("should respect verifySignatures=false option", async () => {
        const vtxo = createMockVtxo({
            virtualStatus: {
                state: "preconfirmed",
                commitmentTxIds: [],
            },
        });

        // Even with signatures disabled, preconfirmed should still fail
        const result = await verifyVtxo(
            vtxo,
            createMockIndexer(),
            createMockOnchain(),
            serverInfo,
            { verifySignatures: false }
        );

        expect(result.valid).toBe(false);
    });
});
