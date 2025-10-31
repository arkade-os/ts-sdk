import { describe, it, expect, vi, beforeEach } from "vitest";
import { Unroll } from "../src/wallet/unroll";
import { ChainTxType } from "../src/providers/indexer";
import { Transaction } from "../src/utils/transaction";

// Mock dependencies
const createMockBumper = () => {
    return {
        bumpP2A: vi
            .fn()
            .mockResolvedValue([
                "parent-transaction-hex",
                "child-transaction-hex",
            ]),
    } as any;
};

const createMockExplorer = () => {
    return {
        getTxStatus: vi.fn(),
        broadcastTransaction: vi.fn().mockResolvedValue(undefined),
    } as any;
};

const createMockIndexer = () => {
    // Create a mock Transaction that will be returned by Transaction.fromPSBT
    const mockTx = {
        getInput: vi.fn().mockReturnValue(null),
        finalize: vi.fn(),
        hex: "finalized-tx-hex",
        id: "tx-id",
    };

    // Mock Transaction.fromPSBT static method
    vi.spyOn(Transaction, "fromPSBT").mockReturnValue(mockTx as any);

    return {
        getVtxoChain: vi.fn(),
        getVirtualTxs: vi.fn().mockResolvedValue({
            // Use a valid base64 string that doesn't need to be a valid PSBT
            // since we're mocking Transaction.fromPSBT anyway
            txs: ["YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo="],
        }),
    } as any;
};

describe("Unroll.Session", () => {
    let mockBumper: any;
    let mockExplorer: any;
    let mockIndexer: any;

    beforeEach(() => {
        mockBumper = createMockBumper();
        mockExplorer = createMockExplorer();
        mockIndexer = createMockIndexer();
        vi.clearAllMocks();
    });

    describe("broadcast option", () => {
        it("should broadcast transactions by default (broadcast=true)", async () => {
            // Setup mock chain with an unconfirmed transaction
            const mockChain = [
                {
                    txid: "mock-txid",
                    type: ChainTxType.ARK,
                },
            ];

            mockIndexer.getVtxoChain.mockResolvedValue({ chain: mockChain });

            // Mock getTxStatus to throw (transaction not found = not onchain)
            mockExplorer.getTxStatus.mockRejectedValue(
                new Error("Transaction not found")
            );

            const session = await Unroll.Session.create(
                { txid: "vtxo-txid", vout: 0 },
                mockBumper,
                mockExplorer,
                mockIndexer,
                true // explicitly enable broadcast
            );

            expect(session.broadcast).toBe(true);

            // Get the next step
            const step = await session.next();

            // Execute the step's do function
            await step.do();

            // Verify that broadcastTransaction was called
            expect(mockExplorer.broadcastTransaction).toHaveBeenCalledWith(
                "parent-transaction-hex",
                "child-transaction-hex"
            );
        });

        it("should not broadcast transactions when broadcast=false", async () => {
            // Setup mock chain with an unconfirmed transaction
            const mockChain = [
                {
                    txid: "mock-txid",
                    type: ChainTxType.ARK,
                },
            ];

            mockIndexer.getVtxoChain.mockResolvedValue({ chain: mockChain });

            // Mock getTxStatus to throw (transaction not found = not onchain)
            mockExplorer.getTxStatus.mockRejectedValue(
                new Error("Transaction not found")
            );

            const session = await Unroll.Session.create(
                { txid: "vtxo-txid", vout: 0 },
                mockBumper,
                mockExplorer,
                mockIndexer,
                false // disable broadcast
            );

            expect(session.broadcast).toBe(false);

            // Get the next step
            const step = await session.next();

            // Execute the step's do function
            await step.do();

            // Verify that broadcastTransaction was NOT called
            expect(mockExplorer.broadcastTransaction).not.toHaveBeenCalled();
        });

        it("should expose transaction hex in UnrollStep", async () => {
            // Setup mock chain with an unconfirmed transaction
            const mockChain = [
                {
                    txid: "mock-txid",
                    type: ChainTxType.ARK,
                },
            ];

            mockIndexer.getVtxoChain.mockResolvedValue({ chain: mockChain });

            // Mock getTxStatus to throw (transaction not found = not onchain)
            mockExplorer.getTxStatus.mockRejectedValue(
                new Error("Transaction not found")
            );

            const session = await Unroll.Session.create(
                { txid: "vtxo-txid", vout: 0 },
                mockBumper,
                mockExplorer,
                mockIndexer,
                false // disable broadcast to just extract hex
            );

            // Get the next step
            const step = await session.next();

            expect(step.type).toBe(Unroll.StepType.UNROLL);
            if (step.type === Unroll.StepType.UNROLL) {
                expect(step.parentHex).toBe("parent-transaction-hex");
                expect(step.childHex).toBe("child-transaction-hex");
                expect(step.tx).toBeDefined();
            }
        });

        it("should use broadcast=true as default", async () => {
            const mockChain = [
                {
                    txid: "mock-txid",
                    type: ChainTxType.COMMITMENT,
                },
            ];

            mockIndexer.getVtxoChain.mockResolvedValue({ chain: mockChain });

            // Create session without explicitly passing broadcast parameter
            const session = await Unroll.Session.create(
                { txid: "vtxo-txid", vout: 0 },
                mockBumper,
                mockExplorer,
                mockIndexer
            );

            expect(session.broadcast).toBe(true);
        });
    });
});
