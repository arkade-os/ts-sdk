import { describe, it, expect, vi } from "vitest";
import transactionHistory from "./fixtures/transaction_history.json";
import { VirtualCoin, TxType, ArkTransaction } from "../src/wallet";
import { buildTransactionHistory as buildTransactionHistoryImpl } from "../src/utils/transactionHistory";
import type { GatedContracts } from "../src/contracts/spendability";
import { gatedContracts, type Contract } from "../src";

type LegacyVirtualStatus = {
    state?: "settled" | "swept" | "spent" | "preconfirmed";
    batchExpiry?: number;
    commitmentTxIds?: string[];
};

function canonicalizeVtxoForTest(vtxo: VirtualCoin): VirtualCoin {
    const legacy = (vtxo as VirtualCoin & { virtualStatus?: LegacyVirtualStatus }).virtualStatus;
    const canonical = { ...vtxo } as VirtualCoin & { virtualStatus?: LegacyVirtualStatus };
    delete canonical.virtualStatus;
    if (!legacy) return canonical;

    if (canonical.isSpent === undefined) canonical.isSpent = legacy.state === "spent";
    if (canonical.isSwept === undefined) canonical.isSwept = legacy.state === "swept";
    if (canonical.isPreconfirmed === undefined) {
        canonical.isPreconfirmed = legacy.state === "preconfirmed";
    }
    if (canonical.spentBy === undefined) canonical.spentBy = "";
    if (canonical.commitmentTxIds === undefined) {
        canonical.commitmentTxIds = legacy.commitmentTxIds ?? [];
    }
    if (canonical.expiresAt === undefined && legacy.batchExpiry !== undefined) {
        canonical.expiresAt = new Date(legacy.batchExpiry);
    }
    return canonical;
}

function buildTransactionHistory(
    vtxos: VirtualCoin[],
    allBoardingTxs: ArkTransaction[],
    commitmentsToIgnore: Set<string>,
    resolveTxCreatedAt?: (txids: string[]) => Promise<Map<string, number>>,
    gatedScripts?: GatedContracts,
) {
    return buildTransactionHistoryImpl(
        vtxos.map(canonicalizeVtxoForTest),
        allBoardingTxs,
        commitmentsToIgnore,
        resolveTxCreatedAt,
        gatedScripts,
    );
}

describe("buildTransactionHistory", () => {
    // TODO FIX THIS!
    describe("Bug: duplicate sent transactions for split vtxos", () => {
        it("should create a single sent transaction when a vtxo is split into multiple outputs", async () => {
            // This reproduces the bug where:
            // - Address: ark1qq4hfssprtcgnjzf8qlw2f78yvjau5kldfugg29k34y7j96q2w4t56dgc5samkp4k49g5exyjk0z4mvpf2c26mwkqkkg6tswhj6laudxnzekfw
            // - TxId: 98b1cdc34d006e0956b1a828c65cd222780348d94b706a69a933ee58b19ab8e0
            // - A 1000 sat vtxo is spent and split into 2x 500 sat vtxos
            // - Expected: 1 sent tx of 500 sats (1000 - 500 change)
            // - Actual bug: 2 sent txs (1000 sats and 500 sats)

            const arkTxId = "98b1cdc34d006e0956b1a828c65cd222780348d94b706a69a933ee58b19ab8e0";
            const commitmentTxId =
                "3a74555034c7f3c8053d0b30441178630dd98f645d9ed42aa9425fdc2279e159";
            const spentByTxId = "90a9f4b835db83cc55a67bc5f362d139e81eb268f4f30b156cc8b0e5a1fdd6b0";
            const baseDate = new Date("2025-10-31T20:00:00Z");

            // The original vtxo that was spent (1000 sats)
            const spentVtxo: VirtualCoin = {
                txid: "9ad04d80b9025762d029388e550c20a12a4fc7373be215cd300e8aacaf7f8e0b",
                vout: 0,
                value: 1000,
                status: {
                    confirmed: true,
                    block_height: 100,
                },
                virtualStatus: {
                    state: "preconfirmed",
                    commitmentTxIds: [commitmentTxId],
                },
                spentBy: spentByTxId,
                arkTxId: arkTxId,
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: true,
            };

            // The two resulting vtxos from the split (500 sats each)
            // Only one is returned to us (change), the other went to the recipient
            const resultVtxo0: VirtualCoin = {
                txid: arkTxId,
                vout: 0,
                value: 500,
                status: {
                    confirmed: false,
                },
                virtualStatus: {
                    state: "preconfirmed",
                },
                createdAt: new Date(baseDate.getTime() + 1000),
                isUnrolled: false,
                isSpent: false,
            };

            // resultVtxo1 went to the recipient, so it's not in our spendable list

            const boardingBatchTxids = new Set<string>();

            const transactions = await buildTransactionHistory(
                [resultVtxo0, spentVtxo],
                [],
                boardingBatchTxids,
            );

            // Filter for sent and received transactions
            const sentTxs = transactions.filter((tx) => tx.type === TxType.TxSent);
            const receivedTxs = transactions.filter((tx) => tx.type === TxType.TxReceived);

            // Expected behavior:
            // - No received transactions (we didn't receive new funds)
            // - One sent transaction of 500 sats (1000 spent - 500 change)

            // TODO: this is correct, believe me.
            expect(receivedTxs).toHaveLength(1);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(500); // 1000 spent - 500 change = 500 sent
            expect(sentTxs[0].key.arkTxid).toBe(arkTxId);
        });

        // TODO: this is a well known issue and we block in the wallet self transfers
        it.skip("should handle the case where both result vtxos belong to the user (self-transfer/split)", async () => {
            // This might be the actual scenario from the bug report:
            // - User spends 1000 sats
            // - Gets back 2x 500 sats (both to their own address)
            // - This is essentially a self-transfer or split
            // - Should show as 0 net sent (or possibly not show at all)

            const arkTxId = "98b1cdc34d006e0956b1a828c65cd222780348d94b706a69a933ee58b19ab8e0";
            const commitmentTxId =
                "3a74555034c7f3c8053d0b30441178630dd98f645d9ed42aa9425fdc2279e159";
            const spentByTxId = "90a9f4b835db83cc55a67bc5f362d139e81eb268f4f30b156cc8b0e5a1fdd6b0";
            const baseDate = new Date("2025-10-31T20:00:00Z");

            const spentVtxo: VirtualCoin = {
                txid: "9ad04d80b9025762d029388e550c20a12a4fc7373be215cd300e8aacaf7f8e0b",
                vout: 0,
                value: 1000,
                status: {
                    confirmed: true,
                    block_height: 100,
                },
                virtualStatus: {
                    state: "preconfirmed",
                    commitmentTxIds: [commitmentTxId],
                },
                spentBy: spentByTxId,
                arkTxId: arkTxId,
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: true,
            };

            // Both resulting vtxos belong to the user
            const resultVtxo0: VirtualCoin = {
                txid: arkTxId,
                vout: 0,
                value: 500,
                status: {
                    confirmed: false,
                },
                virtualStatus: {
                    state: "preconfirmed",
                },
                createdAt: new Date(baseDate.getTime() + 1000),
                isUnrolled: false,
                isSpent: false,
            };

            const resultVtxo1: VirtualCoin = {
                txid: arkTxId,
                vout: 1,
                value: 500,
                status: {
                    confirmed: false,
                },
                virtualStatus: {
                    state: "preconfirmed",
                },
                createdAt: new Date(baseDate.getTime() + 1000),
                isUnrolled: false,
                isSpent: false,
            };

            const transactions = await buildTransactionHistory(
                [resultVtxo0, resultVtxo1],
                [],
                new Set<string>(),
            );
            const sentTxs = transactions.filter((tx) => tx.type === TxType.TxSent);
            const receivedTxs = transactions.filter((tx) => tx.type === TxType.TxReceived);

            // When both outputs come back to the user, it's a self-transfer
            // spentAmount (1000) - resultedAmount (1000) = 0
            // So no sent transaction should be created (filtered out at line 98-100)
            expect(sentTxs).toHaveLength(0);

            // The result vtxos should not show as received either (they're change from our own spend)
            expect(receivedTxs).toHaveLength(0);
        });

        it("should not record a ghost zero-amount sent for a signer-rotation migration", async () => {
            // Migrating all VTXOs to a new signer spends old-signer VTXOs to a single
            // self output of the full amount. spentAmount === changeAmount, so the net
            // sent amount is 0 and no assets move: it must not appear in the history.
            const arkTxId = "migration-ark-tx";
            const baseDate = new Date("2026-06-15T07:45:58Z");

            const oldSignerVtxos: VirtualCoin[] = [1000, 2471, 173875, 7529].map((value, i) => ({
                txid: `old-signer-vtxo-${i}`,
                vout: 0,
                value,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: new Date(baseDate.getTime() - 1000),
                isUnrolled: false,
                isSpent: true,
                arkTxId,
            }));

            // Single new-signer output holding the full migrated amount (self change).
            const newSignerOutput: VirtualCoin = {
                txid: arkTxId,
                vout: 0,
                value: 184875,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: false,
            };

            const txs = await buildTransactionHistory(
                [...oldSignerVtxos, newSignerOutput],
                [],
                new Set<string>(),
            );

            // No sent tx at all, and nothing keyed by the migration tx (the ghost).
            expect(txs.filter((t) => t.type === TxType.TxSent)).toHaveLength(0);
            expect(txs.some((t) => t.key.arkTxid === arkTxId)).toBe(false);
            // The new-signer self output is change, not a receive.
            expect(txs.some((t) => t.amount === 184875)).toBe(false);
        });
    });

    describe("Receive transactions", () => {
        it("should suppress duplicate batch received entries for boarding sweeps", async () => {
            const boardingTxid = "boarding-txid";
            const sweepTxid = "sweep-txid-onchain";
            const indexerCommitmentTxid = "sweep-txid-indexer"; // Differing IDs should still be handled
            const amount = 1000;
            const baseDate = new Date("2026-05-28T10:00:00Z");

            // 1. Boarding transaction as returned by the improved getBoardingTxs()
            const boardingTx: ArkTransaction = {
                key: {
                    boardingTxid: boardingTxid,
                    commitmentTxid: sweepTxid,
                    arkTxid: "",
                },
                amount: amount,
                type: TxType.TxReceived,
                settled: true,
                createdAt: baseDate.getTime(),
            };

            // 2. Leaf VTXO as returned by the indexer
            const leafVtxo: VirtualCoin = {
                txid: "leaf-vtxo-txid",
                vout: 0,
                value: amount,
                status: {
                    confirmed: true,
                    isLeaf: true,
                },
                virtualStatus: {
                    state: "settled",
                    commitmentTxIds: [indexerCommitmentTxid],
                },
                settledBy: sweepTxid, // This matches the on-chain sweep txid
                createdAt: new Date(baseDate.getTime() + 60000),
                isUnrolled: false,
                isSpent: false,
            };

            const commitmentsToIgnore = new Set<string>([sweepTxid]);

            const transactions = await buildTransactionHistory(
                [leafVtxo],
                [boardingTx],
                commitmentsToIgnore,
            );

            const receivedTxs = transactions.filter((tx) => tx.type === TxType.TxReceived);

            // Expect only 1 entry: the enriched boarding entry
            expect(receivedTxs).toHaveLength(1);
            expect(receivedTxs[0].key.boardingTxid).toBe(boardingTxid);
            expect(receivedTxs[0].key.commitmentTxid).toBe(sweepTxid);
        });

        it("should suppress duplicate boarding batch receives when the boarding commitment id is missing", async () => {
            const boardingTxid = "boarding-txid";
            const indexerCommitmentTxid =
                "ebf6bebe7b510934cf2ed3c167f77ea06d19cc104edf8b66e4721a103e0ed4f3";
            const amount = 84960;
            const baseDate = new Date("2026-05-27T20:00:00Z");

            const boardingTx: ArkTransaction = {
                key: {
                    boardingTxid,
                    commitmentTxid: "",
                    arkTxid: "",
                },
                amount,
                type: TxType.TxReceived,
                settled: true,
                createdAt: baseDate.getTime(),
            };

            const leafVtxo: VirtualCoin = {
                txid: "86e31825f6a50d88c71eca33c7b4830d0aae4f320c12b12df0053c7b341cd4f3",
                vout: 0,
                value: amount,
                status: {
                    confirmed: true,
                    isLeaf: true,
                },
                virtualStatus: {
                    state: "settled",
                    commitmentTxIds: [indexerCommitmentTxid],
                },
                settledBy: "",
                createdAt: new Date(baseDate.getTime() + 104000),
                isUnrolled: false,
                isSpent: false,
            };

            const transactions = await buildTransactionHistory(
                [leafVtxo],
                [boardingTx],
                new Set<string>(),
            );

            const receivedTxs = transactions.filter((tx) => tx.type === TxType.TxReceived);

            expect(receivedTxs).toHaveLength(1);
            expect(receivedTxs[0].key.boardingTxid).toBe(boardingTxid);
            expect(
                receivedTxs.some(
                    (tx) =>
                        tx.key.boardingTxid === "" &&
                        tx.key.commitmentTxid === indexerCommitmentTxid,
                ),
            ).toBe(false);
        });

        it("should suppress duplicate boarding batch receives when settledBy is missing", async () => {
            const boardingTxid = "boarding-txid";
            const sweepTxid = "onchain-sweep-txid";
            const indexerCommitmentTxid =
                "ebf6bebe7b510934cf2ed3c167f77ea06d19cc104edf8b66e4721a103e0ed4f3";
            const amount = 84960;
            const baseDate = new Date("2026-05-27T20:00:00Z");

            const boardingTx: ArkTransaction = {
                key: {
                    boardingTxid,
                    commitmentTxid: sweepTxid,
                    arkTxid: "",
                },
                amount,
                type: TxType.TxReceived,
                settled: true,
                createdAt: baseDate.getTime(),
            };

            const leafVtxo: VirtualCoin = {
                txid: "86e31825f6a50d88c71eca33c7b4830d0aae4f320c12b12df0053c7b341cd4f3",
                vout: 0,
                value: amount,
                status: {
                    confirmed: true,
                    isLeaf: true,
                },
                virtualStatus: {
                    state: "settled",
                    commitmentTxIds: [indexerCommitmentTxid],
                },
                settledBy: "",
                createdAt: new Date(baseDate.getTime() + 104000),
                isUnrolled: false,
                isSpent: false,
            };

            const transactions = await buildTransactionHistory(
                [leafVtxo],
                [boardingTx],
                new Set<string>([sweepTxid]),
            );

            const receivedTxs = transactions.filter((tx) => tx.type === TxType.TxReceived);

            expect(receivedTxs).toHaveLength(1);
            expect(receivedTxs[0].key.boardingTxid).toBe(boardingTxid);
            expect(
                receivedTxs.some(
                    (tx) =>
                        tx.key.boardingTxid === "" &&
                        tx.key.commitmentTxid === indexerCommitmentTxid,
                ),
            ).toBe(false);
        });

        it("should only suppress one same-amount batch receive per settled boarding entry", async () => {
            const amount = 84960;
            const baseDate = new Date("2026-05-27T20:00:00Z");
            const boardingTx: ArkTransaction = {
                key: {
                    boardingTxid: "boarding-txid",
                    commitmentTxid: "onchain-sweep-txid",
                    arkTxid: "",
                },
                amount,
                type: TxType.TxReceived,
                settled: true,
                createdAt: baseDate.getTime(),
            };
            const boardingSweepLeaf: VirtualCoin = {
                txid: "boarding-sweep-vtxo",
                vout: 0,
                value: amount,
                status: { confirmed: true, isLeaf: true },
                virtualStatus: {
                    state: "settled",
                    commitmentTxIds: ["indexer-boarding-commitment"],
                },
                settledBy: "",
                createdAt: new Date(baseDate.getTime() + 60000),
                isUnrolled: false,
                isSpent: false,
            };
            const independentReceiveLeaf: VirtualCoin = {
                txid: "independent-receive-vtxo",
                vout: 0,
                value: amount,
                status: { confirmed: true, isLeaf: true },
                virtualStatus: {
                    state: "settled",
                    commitmentTxIds: ["independent-receive-commitment"],
                },
                settledBy: "",
                createdAt: new Date(baseDate.getTime() + 120000),
                isUnrolled: false,
                isSpent: false,
            };

            const transactions = await buildTransactionHistory(
                [boardingSweepLeaf, independentReceiveLeaf],
                [boardingTx],
                new Set<string>(["onchain-sweep-txid"]),
            );

            const receivedTxs = transactions.filter((tx) => tx.type === TxType.TxReceived);

            expect(receivedTxs).toHaveLength(2);
            expect(
                receivedTxs.some(
                    (tx) => tx.key.commitmentTxid === "independent-receive-commitment",
                ),
            ).toBe(true);
        });

        it("does not double-count when several boardings are swept into one combined VTXO (arkade.money N->1 regression)", async () => {
            // Feb 2026 mainnet incident: two boarding deposits (76,186 + 152,346)
            // were swept into a single 228,532 VTXO in commitment 58b3d35a. With
            // the commitment ignored, the swept VTXO must be suppressed, leaving
            // only the two boarding receives — net 228,532, NOT 457,064. The
            // amount-fallback dedup cannot catch this (no single boarding equals
            // the combined value), so it relies on the commitment-id match that
            // getBoardingTxs() now populates reliably.
            const sweepTxid = "58b3d35a7f0fb5f0a67294d28c409a8acaf56fd95b3aedcfbfa74b96e918ff11";

            const boarding1: ArkTransaction = {
                key: { boardingTxid: "1aece24a", commitmentTxid: sweepTxid, arkTxid: "" },
                amount: 76186,
                type: TxType.TxReceived,
                settled: true,
                createdAt: new Date("2026-02-23T17:06:18Z").getTime(),
            };
            const boarding2: ArkTransaction = {
                key: { boardingTxid: "a4f9f575", commitmentTxid: sweepTxid, arkTxid: "" },
                amount: 152346,
                type: TxType.TxReceived,
                settled: true,
                createdAt: new Date("2026-02-23T18:37:36Z").getTime(),
            };
            const combinedVtxo: VirtualCoin = {
                txid: "34592d08e0a22d91d58a9e80afdc87073831e5bea856e985daf52fadee62063c",
                vout: 0,
                value: 228532,
                status: { confirmed: true, isLeaf: true },
                virtualStatus: { state: "settled", commitmentTxIds: [sweepTxid] },
                settledBy: "",
                createdAt: new Date("2026-02-23T19:59:12Z"),
                isUnrolled: false,
                isSpent: false,
            };

            const transactions = await buildTransactionHistory(
                [combinedVtxo],
                [boarding1, boarding2],
                new Set([sweepTxid]),
            );

            const received = transactions.filter((tx) => tx.type === TxType.TxReceived);
            const net = received.reduce((acc, tx) => acc + tx.amount, 0);

            // Net inflow equals the deposited amount; no phantom VTXO receive.
            expect(net).toBe(228532);
            // The combined VTXO must NOT surface as its own receive (would inflate).
            expect(received.some((tx) => tx.amount === 228532)).toBe(false);
            // Both boarding deposits are present.
            expect(received.filter((tx) => tx.key.boardingTxid !== "")).toHaveLength(2);
        });

        it("suppresses a boarding sweep whose VTXO batches in refreshed funds (Dec refill regression)", async () => {
            // Dec 2025 mainnet incident: a 28,469 boarding deposit settled into an
            // 82,147 VTXO because the same commitment refreshed 53,678 of existing
            // VTXOs. Showing the 82,147 VTXO would double-count the refreshed part,
            // so the swept VTXO is suppressed and only the boarding deposit shows.
            const sweepTxid = "d5e1c7cf6387ed6725a9a7af3eb9e46f2991275c4685c4701389ce0e8455d7d3";

            const boarding: ArkTransaction = {
                key: { boardingTxid: "f53e56e8", commitmentTxid: sweepTxid, arkTxid: "" },
                amount: 28469,
                type: TxType.TxReceived,
                settled: true,
                createdAt: new Date("2025-12-06T12:13:48Z").getTime(),
            };
            // The combined leaf created by the sweep (boarding + refreshed funds).
            const combinedVtxo: VirtualCoin = {
                txid: "d46e8991f8bc534f63cd05cf673791d024a440fde9e80891eb5698fb53dff7ec",
                vout: 0,
                value: 82147,
                status: { confirmed: true, isLeaf: true },
                virtualStatus: { state: "settled", commitmentTxIds: [sweepTxid] },
                settledBy: "",
                createdAt: new Date("2025-12-10T13:47:08Z"),
                isUnrolled: false,
                isSpent: false,
            };

            const transactions = await buildTransactionHistory(
                [combinedVtxo],
                [boarding],
                new Set([sweepTxid]),
            );

            const received = transactions.filter((tx) => tx.type === TxType.TxReceived);
            // Only the boarding deposit is counted; the 82,147 combined leaf is hidden.
            expect(received.reduce((acc, tx) => acc + tx.amount, 0)).toBe(28469);
            expect(received.some((tx) => tx.amount === 82147)).toBe(false);
        });

        it("should create a receive transaction for a new vtxo", async () => {
            const arkTxId = "receive-ark-tx-id";
            const baseDate = new Date("2025-10-31T20:00:00Z");

            const receivedVtxo: VirtualCoin = {
                txid: arkTxId,
                vout: 0,
                value: 1000,
                status: {
                    confirmed: false,
                },
                virtualStatus: {
                    state: "preconfirmed",
                },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: false,
            };

            const spendable = [receivedVtxo];
            const spent: VirtualCoin[] = [];
            const boardingBatchTxids = new Set<string>();

            const transactions = await buildTransactionHistory(
                [receivedVtxo],
                [],
                boardingBatchTxids,
            );
            const receivedTxs = transactions.filter((tx) => tx.type === TxType.TxReceived);

            expect(receivedTxs).toHaveLength(1);
            expect(receivedTxs[0].amount).toBe(1000);
            expect(receivedTxs[0].key.arkTxid).toBe(arkTxId);
        });
    });

    describe("Asset history", () => {
        const baseDate = new Date("2025-11-01T12:00:00Z");
        const assetA = "asset-id-aaa";
        const assetB = "asset-id-bbb";

        it("should include assets on offchain received transaction", async () => {
            const vtxo: VirtualCoin = {
                txid: "offchain-rx-tx",
                vout: 0,
                value: 1000,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: false,
                assets: [{ assetId: assetA, amount: 50n }],
            };

            const txs = await buildTransactionHistory([vtxo], [], new Set());

            expect(txs).toHaveLength(1);
            expect(txs[0].type).toBe(TxType.TxReceived);
            expect(txs[0].assets).toStrictEqual([{ assetId: assetA, amount: 50n }]);
        });

        it("should include assets on batch received transaction", async () => {
            const commitmentTxId = "batch-commitment-tx";
            const vtxo: VirtualCoin = {
                txid: "batch-rx-vtxo",
                vout: 0,
                value: 2000,
                status: { confirmed: true, isLeaf: true },
                virtualStatus: {
                    state: "settled",
                    commitmentTxIds: [commitmentTxId],
                },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: false,
                assets: [
                    { assetId: assetA, amount: 10n },
                    { assetId: assetB, amount: 20n },
                ],
            };

            const txs = await buildTransactionHistory([vtxo], [], new Set());

            expect(txs).toHaveLength(1);
            expect(txs[0].type).toBe(TxType.TxReceived);
            expect(txs[0].tag).toBe("batch");
            expect(txs[0].assets).toStrictEqual([
                { assetId: assetA, amount: 10n },
                { assetId: assetB, amount: 20n },
            ]);
        });

        it("should not include assets property when vtxos have no assets", async () => {
            const vtxo: VirtualCoin = {
                txid: "no-asset-tx",
                vout: 0,
                value: 500,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: false,
            };

            const txs = await buildTransactionHistory([vtxo], [], new Set());

            expect(txs).toHaveLength(1);
            expect(txs[0]).not.toHaveProperty("assets");
        });

        it("should subtract assets for offchain sent with change", async () => {
            const arkTxId = "offchain-sent-ark-tx";

            const spentVtxo: VirtualCoin = {
                txid: "spent-vtxo-1",
                vout: 0,
                value: 1000,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: true,
                arkTxId,
                assets: [{ assetId: assetA, amount: 100n }],
            };

            const changeVtxo: VirtualCoin = {
                txid: arkTxId,
                vout: 0,
                value: 400,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: new Date(baseDate.getTime() + 1000),
                isUnrolled: false,
                isSpent: false,
                assets: [{ assetId: assetA, amount: 30n }],
            };

            const txs = await buildTransactionHistory([spentVtxo, changeVtxo], [], new Set());

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(600);
            expect(sentTxs[0].assets).toStrictEqual([{ assetId: assetA, amount: -70n }]);
        });

        it("should omit assets on sent tx when all assets go to change", async () => {
            const arkTxId = "offchain-sent-all-change";

            const spentVtxo: VirtualCoin = {
                txid: "spent-vtxo-2",
                vout: 0,
                value: 1000,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: true,
                arkTxId,
                assets: [{ assetId: assetA, amount: 50n }],
            };

            const changeVtxo: VirtualCoin = {
                txid: arkTxId,
                vout: 0,
                value: 400,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: new Date(baseDate.getTime() + 1000),
                isUnrolled: false,
                isSpent: false,
                assets: [{ assetId: assetA, amount: 50n }],
            };

            const txs = await buildTransactionHistory([spentVtxo, changeVtxo], [], new Set());

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(600);
            expect(sentTxs[0]).not.toHaveProperty("assets");
        });

        it("should collect assets for offchain sent without change", async () => {
            const arkTxId = "offchain-sent-no-change";

            const spentVtxo: VirtualCoin = {
                txid: "spent-vtxo-3",
                vout: 0,
                value: 1000,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: true,
                arkTxId,
                assets: [
                    { assetId: assetA, amount: 40n },
                    { assetId: assetB, amount: 60n },
                ],
            };

            const txs = await buildTransactionHistory([spentVtxo], [], new Set());

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(1000);
            expect(sentTxs[0].assets).toStrictEqual([
                { assetId: assetA, amount: -40n },
                { assetId: assetB, amount: -60n },
            ]);
        });

        it("should include assets on exit sent with change", async () => {
            const commitmentTxId = "exit-commitment-with-change";

            const forfeitVtxo: VirtualCoin = {
                txid: "forfeit-vtxo-1",
                vout: 0,
                value: 2000,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: true,
                settledBy: commitmentTxId,
                assets: [{ assetId: assetA, amount: 80n }],
            };

            const changeVtxo: VirtualCoin = {
                txid: "change-leaf-vtxo",
                vout: 0,
                value: 500,
                status: { confirmed: true, isLeaf: true },
                virtualStatus: {
                    state: "settled",
                    commitmentTxIds: [commitmentTxId],
                },
                createdAt: new Date(baseDate.getTime() + 1000),
                isUnrolled: false,
                isSpent: false,
                assets: [{ assetId: assetA, amount: 20n }],
            };

            const txs = await buildTransactionHistory([forfeitVtxo, changeVtxo], [], new Set());

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].tag).toBe("exit");
            expect(sentTxs[0].amount).toBe(1500);
            expect(sentTxs[0].assets).toStrictEqual([{ assetId: assetA, amount: -60n }]);
        });

        it("should include assets on exit sent without change", async () => {
            const commitmentTxId = "exit-commitment-no-change";

            const forfeitVtxo: VirtualCoin = {
                txid: "forfeit-vtxo-2",
                vout: 0,
                value: 1000,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: true,
                settledBy: commitmentTxId,
                assets: [{ assetId: assetB, amount: 75n }],
            };

            const txs = await buildTransactionHistory([forfeitVtxo], [], new Set());

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].tag).toBe("exit");
            expect(sentTxs[0].amount).toBe(1000);
            expect(sentTxs[0].assets).toStrictEqual([{ assetId: assetB, amount: -75n }]);
        });

        it("should include assets on issuance (self-send with new assets in change)", async () => {
            const arkTxId = "issuance-ark-tx";

            const spentVtxo: VirtualCoin = {
                txid: "spent-vtxo-issuance",
                vout: 0,
                value: 1000,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: true,
                arkTxId,
            };

            const changeVtxo: VirtualCoin = {
                txid: arkTxId,
                vout: 0,
                value: 1000,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: new Date(baseDate.getTime() + 1000),
                isUnrolled: false,
                isSpent: false,
                assets: [{ assetId: assetA, amount: 100n }],
            };

            const txs = await buildTransactionHistory([spentVtxo, changeVtxo], [], new Set());

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(0);
            expect(sentTxs[0].assets).toStrictEqual([{ assetId: assetA, amount: 100n }]);
        });

        it("should include assets on reissuance (change has more assets than spent)", async () => {
            const arkTxId = "reissuance-ark-tx";

            const spentVtxo: VirtualCoin = {
                txid: "spent-vtxo-reissuance",
                vout: 0,
                value: 1000,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: true,
                arkTxId,
                assets: [{ assetId: assetA, amount: 50n }],
            };

            const changeVtxo: VirtualCoin = {
                txid: arkTxId,
                vout: 0,
                value: 1000,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: new Date(baseDate.getTime() + 1000),
                isUnrolled: false,
                isSpent: false,
                assets: [{ assetId: assetA, amount: 150n }],
            };

            const txs = await buildTransactionHistory([spentVtxo, changeVtxo], [], new Set());

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(0);
            expect(sentTxs[0].assets).toStrictEqual([{ assetId: assetA, amount: 100n }]);
        });

        it("should include negative assets on burn (self-send with fewer assets in change)", async () => {
            const arkTxId = "burn-ark-tx";

            // Spent VTXO has assets
            const spentVtxo: VirtualCoin = {
                txid: "spent-vtxo-burn",
                vout: 0,
                value: 1000,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: true,
                arkTxId,
                assets: [{ assetId: assetA, amount: 100n }],
            };

            // Change VTXO has all BTC back but no assets (fully burned)
            const changeVtxo: VirtualCoin = {
                txid: arkTxId,
                vout: 0,
                value: 1000,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: new Date(baseDate.getTime() + 1000),
                isUnrolled: false,
                isSpent: false,
            };

            const txs = await buildTransactionHistory([spentVtxo, changeVtxo], [], new Set());

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(0);
            // Negative = assets lost/burned
            expect(sentTxs[0].assets).toStrictEqual([{ assetId: assetA, amount: -100n }]);
        });

        it("should handle mixed operation: burn + issuance + transfer in same tx", async () => {
            const arkTxId = "mixed-ops-ark-tx";
            const assetC = "asset-id-ccc";

            // Spent VTXO has ASSET_A (will be burned) and ASSET_B (partially transferred)
            const spentVtxo: VirtualCoin = {
                txid: "spent-vtxo-mixed",
                vout: 0,
                value: 1000,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: true,
                arkTxId,
                assets: [
                    { assetId: assetA, amount: 50n }, // will be fully burned
                    { assetId: assetB, amount: 80n }, // 30 will be transferred
                ],
            };

            // Change VTXO: no ASSET_A (burned), less ASSET_B (transferred), new ASSET_C (issued)
            const changeVtxo: VirtualCoin = {
                txid: arkTxId,
                vout: 0,
                value: 500,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: new Date(baseDate.getTime() + 1000),
                isUnrolled: false,
                isSpent: false,
                assets: [
                    { assetId: assetB, amount: 50n }, // kept 50 of 80
                    { assetId: assetC, amount: 200n }, // newly issued
                ],
            };

            const txs = await buildTransactionHistory([spentVtxo, changeVtxo], [], new Set());

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(500);
            expect(sentTxs[0].assets).toStrictEqual([
                { assetId: assetB, amount: -30n }, // transferred/lost
                { assetId: assetC, amount: 200n }, // issued/gained
                { assetId: assetA, amount: -50n }, // burned/lost
            ]);
        });

        it("should aggregate assets from multiple spent vtxos", async () => {
            const arkTxId = "multi-spent-ark-tx";

            const spentVtxo1: VirtualCoin = {
                txid: "multi-spent-1",
                vout: 0,
                value: 500,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: baseDate,
                isUnrolled: false,
                isSpent: true,
                arkTxId,
                assets: [{ assetId: assetA, amount: 30n }],
            };

            const spentVtxo2: VirtualCoin = {
                txid: "multi-spent-2",
                vout: 0,
                value: 500,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: new Date(baseDate.getTime() + 100),
                isUnrolled: false,
                isSpent: true,
                arkTxId,
                assets: [
                    { assetId: assetA, amount: 20n },
                    { assetId: assetB, amount: 10n },
                ],
            };

            const txs = await buildTransactionHistory([spentVtxo1, spentVtxo2], [], new Set());

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(1000);
            expect(sentTxs[0].assets).toStrictEqual([
                { assetId: assetA, amount: -50n },
                { assetId: assetB, amount: -10n },
            ]);
        });
    });

    describe("batched createdAt resolver", () => {
        const baseDate = new Date("2025-11-01T10:00:00Z");

        const spentVtxo = (txid: string, arkTxId: string, createdAt = baseDate): VirtualCoin => ({
            txid,
            vout: 0,
            value: 1000,
            status: { confirmed: false },
            virtualStatus: { state: "preconfirmed" },
            createdAt,
            isUnrolled: false,
            isSpent: true,
            arkTxId,
        });

        it("calls the resolver once with all distinct txids, deduped", async () => {
            const resolver = vi.fn((txids: string[]) =>
                Promise.resolve(new Map(txids.map((t, i) => [t, 1_700_000_000_000 + i] as const))),
            );

            const txs = await buildTransactionHistory(
                [
                    spentVtxo("in-a", "ark-tx-1"),
                    spentVtxo("in-b", "ark-tx-1", new Date(baseDate.getTime() + 1000)),
                    spentVtxo("in-c", "ark-tx-2"),
                ],
                [],
                new Set(),
                resolver,
            );

            expect(resolver).toHaveBeenCalledTimes(1);
            expect(resolver.mock.calls[0][0].slice().sort()).toStrictEqual([
                "ark-tx-1",
                "ark-tx-2",
            ]);

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(2);
            const byTxid = new Map(sentTxs.map((t) => [t.key.arkTxid, t.createdAt]));
            expect(byTxid.get("ark-tx-1")).toBe(1_700_000_000_000);
            expect(byTxid.get("ark-tx-2")).toBe(1_700_000_000_001);
        });

        it("does not call the resolver when every spending tx has a change output", async () => {
            const resolver = vi.fn((txids: string[]) => Promise.resolve(new Map<string, number>()));

            const changeVtxo: VirtualCoin = {
                txid: "ark-tx-1",
                vout: 0,
                value: 400,
                status: { confirmed: false },
                virtualStatus: { state: "preconfirmed" },
                createdAt: new Date(baseDate.getTime() + 1000),
                isUnrolled: false,
                isSpent: false,
            };

            const txs = await buildTransactionHistory(
                [spentVtxo("in-a", "ark-tx-1"), changeVtxo],
                [],
                new Set(),
                resolver,
            );

            expect(resolver).not.toHaveBeenCalled();
            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].createdAt).toBe(baseDate.getTime() + 1000);
        });

        it("falls back to createdAt + 1 for txids missing from a partial map", async () => {
            const resolver = vi.fn((_txids: string[]) =>
                Promise.resolve(new Map([["ark-tx-1", 1_700_000_000_000]])),
            );

            const txs = await buildTransactionHistory(
                [spentVtxo("in-a", "ark-tx-1"), spentVtxo("in-b", "ark-tx-2")],
                [],
                new Set(),
                resolver,
            );

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(2);
            const byTxid = new Map(sentTxs.map((t) => [t.key.arkTxid, t.createdAt]));
            expect(byTxid.get("ark-tx-1")).toBe(1_700_000_000_000);
            expect(byTxid.get("ark-tx-2")).toBe(baseDate.getTime() + 1);
        });
    });

    /**
     * The gate history shares with `getBalance`: VTXOs locked to a contract row
     * generic spending is closed on are read as an external counterparty, not as
     * the wallet's own coins.
     *
     * Without it a swap covenant registered by `@arkade-os/swap` is a contract
     * of the funding wallet, so its deposit output counts as change: the sats
     * net to zero, `subtractAssets` cancels the units to nothing, and the guard
     * against ghost rows drops the whole movement. Funding, fill and cancel each
     * produce no row at all, and an asset-side swap — whose whole movement is
     * asset units on a dust carrier — disappears completely.
     *
     * Assertions key on the ark txid of the leg under test rather than on the
     * whole array. Each fixture starts from a coin the wallet already held, and
     * the transaction that created *that* is outside the fixture, so the builder
     * reports it as an earlier receive — correctly, and irrelevantly here.
     */
    describe("Gated contracts (swap covenants)", () => {
        const baseDate = new Date("2026-02-01T10:00:00Z");
        const at = (offsetMs: number) => new Date(baseDate.getTime() + offsetMs);
        const assetX = "asset-id-xxx";

        const walletScript = "wallet-receive-script";
        const covenantScript = "swap-covenant-script";

        /**
         * A spend is a checkpoint per input plus the ark tx that spends the
         * checkpoints, so `spentBy` and `arkTxId` are never the same value. The
         * builder keys on `arkTxId`; `spentBy` is here so the fixtures are the
         * shape `convertVtxo` actually produces.
         */
        const checkpointOf = (arkTxid: string) => `${arkTxid}-checkpoint`;

        /** The three fields that together say "this coin was spent by that tx". */
        const spentIn = (arkTxid: string) => ({
            isSpent: true,
            spentBy: checkpointOf(arkTxid),
            arkTxId: arkTxid,
        });

        /** A contract row the way `@arkade-os/swap`'s `createOffer` registers it. */
        const offerContract = (overrides: Partial<Contract> = {}): Contract => ({
            type: "arkade",
            params: {},
            script: covenantScript,
            address: "ark1swapcovenant",
            state: "active",
            createdAt: baseDate.getTime(),
            metadata: { genericallySpendable: false, kind: "asset-swap-offer" },
            ...overrides,
        });

        /**
         * The builder under the gate both read paths build, straight off the
         * contract rows. Boarding transactions and ignored commitments are
         * beside the point here, and no `createdAt` resolver is wired: the one
         * test that cares whether it is called passes its own.
         */
        const history = (vtxos: VirtualCoin[], contract: Contract = offerContract()) =>
            buildTransactionHistory(vtxos, [], new Set(), undefined, gatedContracts([contract]));

        /** The same builder with no gate at all: the behaviour that predates it. */
        const ungatedHistory = (vtxos: VirtualCoin[]) =>
            buildTransactionHistory(vtxos, [], new Set());

        /**
         * A funding fixture with its covenant coin spent by whichever leg closes
         * the offer — a solver's fill, or a cancel. Keyed on the script rather
         * than a position, so it survives a fixture growing an output.
         */
        const closedBy = (coins: VirtualCoin[], txid: string) =>
            coins.map((c) => (c.script === covenantScript ? { ...c, ...spentIn(txid) } : c));

        const coin = (
            over: Partial<VirtualCoin> & Pick<VirtualCoin, "txid" | "value">,
        ): VirtualCoin => ({
            vout: 0,
            status: { confirmed: false },
            virtualStatus: { state: "preconfirmed" },
            createdAt: baseDate,
            isUnrolled: false,
            isSpent: false,
            script: walletScript,
            ...over,
        });

        const sentOf = (txs: ArkTransaction[]) => txs.filter((t) => t.type === TxType.TxSent);
        const rowsFor = (txs: ArkTransaction[], arkTxid: string) =>
            txs.filter((t) => t.key.arkTxid === arkTxid);
        const sentFor = (txs: ArkTransaction[], arkTxid: string) => sentOf(rowsFor(txs, arkTxid));
        const receivedFor = (txs: ArkTransaction[], arkTxid: string) =>
            rowsFor(txs, arkTxid).filter((t) => t.type === TxType.TxReceived);

        describe("BTC give, asset want", () => {
            const fundingTxid = "btc-give-funding-tx";
            const fillTxid = "btc-give-fill-tx";
            const cancelTxid = "btc-give-cancel-tx";

            /** 10_000 sats in, 6_000 into the covenant, 4_000 back as change. */
            const funding = () => [
                coin({
                    txid: "wallet-coin-btc-give",
                    value: 10_000,
                    ...spentIn(fundingTxid),
                }),
                coin({
                    txid: fundingTxid,
                    vout: 0,
                    value: 6_000,
                    script: covenantScript,
                    createdAt: at(1_000),
                }),
                coin({
                    txid: fundingTxid,
                    vout: 1,
                    value: 4_000,
                    createdAt: at(1_000),
                }),
            ];

            it("records the deposit as a send once the covenant is funded", async () => {
                const txs = await history(funding());

                const sent = sentFor(txs, fundingTxid);
                expect(sent).toHaveLength(1);
                expect(sent[0].amount).toBe(6_000);
                // Attributable, not silently dropped: the counterparty is the
                // user's own escrow, not a stranger.
                expect(sent[0].tag).toBe("gated");
                // The change output is change, and the covenant output is not a receive.
                expect(receivedFor(txs, fundingTxid)).toHaveLength(0);
            });

            it("records the solver's fill as a receive of the bought asset", async () => {
                const txs = await history([
                    ...closedBy(funding(), fillTxid),
                    coin({
                        txid: fillTxid,
                        value: 330,
                        createdAt: at(2_000),
                        assets: [{ assetId: assetX, amount: 5_000n }],
                    }),
                ]);

                // The escrow leaving is not a second send: it was already sent.
                const sent = sentOf(txs);
                expect(sent).toHaveLength(1);
                expect(sent[0].key.arkTxid).toBe(fundingTxid);
                expect(sent[0].amount).toBe(6_000);

                const received = receivedFor(txs, fillTxid);
                expect(received).toHaveLength(1);
                expect(received[0].amount).toBe(330);
                expect(received[0].assets).toStrictEqual([{ assetId: assetX, amount: 5_000n }]);
                expect(received[0].tag).toBe("gated");
            });

            it("records a cancel as the deposit coming back", async () => {
                const txs = await history([
                    ...closedBy(funding(), cancelTxid),
                    coin({ txid: cancelTxid, value: 6_000, createdAt: at(2_000) }),
                ]);

                const sent = sentOf(txs);
                expect(sent).toHaveLength(1);
                expect(sent[0].key.arkTxid).toBe(fundingTxid);

                const received = receivedFor(txs, cancelTxid);
                expect(received).toHaveLength(1);
                expect(received[0].amount).toBe(6_000);
                expect(received[0].tag).toBe("gated");
            });

            it("nets the funding to nothing with the covenant left in the wallet's set", async () => {
                // The defect itself, and the guard against a silent revert: with
                // no gate the covenant output is change, so `spentAmount -
                // changeAmount` is 0, no assets move, and the ghost-row guard
                // drops the only record the swap would have had.
                const txs = await ungatedHistory(funding());
                expect(sentOf(txs)).toHaveLength(0);
                expect(rowsFor(txs, fundingTxid)).toHaveLength(0);
            });
        });

        describe("asset give, BTC want", () => {
            const fundingTxid = "asset-give-funding-tx";
            const fillTxid = "asset-give-fill-tx";
            const cancelTxid = "asset-give-cancel-tx";

            /**
             * The whole movement is asset-side: 1_000 units ride a 500-sat dust
             * carrier into the covenant, with no change.
             */
            const funding = () => [
                coin({
                    txid: "wallet-coin-asset-give",
                    value: 500,
                    ...spentIn(fundingTxid),
                    assets: [{ assetId: assetX, amount: 1_000n }],
                }),
                coin({
                    txid: fundingTxid,
                    vout: 0,
                    value: 500,
                    script: covenantScript,
                    createdAt: at(1_000),
                    assets: [{ assetId: assetX, amount: 1_000n }],
                }),
            ];

            it("records the deposited units on the funding send", async () => {
                const txs = await history(funding());

                const sent = sentFor(txs, fundingTxid);
                expect(sent).toHaveLength(1);
                // The carrier sats are the amount; the units are the movement.
                expect(sent[0].amount).toBe(500);
                expect(sent[0].assets).toStrictEqual([{ assetId: assetX, amount: -1_000n }]);
                expect(sent[0].tag).toBe("gated");
                expect(receivedFor(txs, fundingTxid)).toHaveLength(0);
            });

            it("leaves units that stayed behind out of the funding send", async () => {
                const txs = await history([
                    coin({
                        txid: "wallet-coin-asset-partial",
                        value: 800,
                        ...spentIn(fundingTxid),
                        assets: [{ assetId: assetX, amount: 1_000n }],
                    }),
                    coin({
                        txid: fundingTxid,
                        vout: 0,
                        value: 300,
                        script: covenantScript,
                        createdAt: at(1_000),
                        assets: [{ assetId: assetX, amount: 600n }],
                    }),
                    coin({
                        txid: fundingTxid,
                        vout: 1,
                        value: 500,
                        createdAt: at(1_000),
                        assets: [{ assetId: assetX, amount: 400n }],
                    }),
                ]);

                const sent = sentFor(txs, fundingTxid);
                expect(sent).toHaveLength(1);
                expect(sent[0].amount).toBe(300);
                // 600 deposited, not the 1_000 the input carried.
                expect(sent[0].assets).toStrictEqual([{ assetId: assetX, amount: -600n }]);
            });

            it("records the fill as a receive of the sats the solver paid", async () => {
                const txs = await history([
                    ...closedBy(funding(), fillTxid),
                    coin({ txid: fillTxid, value: 9_000, createdAt: at(2_000) }),
                ]);

                const received = receivedFor(txs, fillTxid);
                expect(received).toHaveLength(1);
                expect(received[0].amount).toBe(9_000);
                expect(received[0]).not.toHaveProperty("assets");
                expect(received[0].tag).toBe("gated");

                // The escrowed units leave once, on the funding row — the fill
                // must not report them as a second send.
                const sent = sentOf(txs);
                expect(sent).toHaveLength(1);
                expect(sent[0].key.arkTxid).toBe(fundingTxid);
            });

            it("records a cancel as every unit coming back", async () => {
                const txs = await history([
                    ...closedBy(funding(), cancelTxid),
                    coin({
                        txid: cancelTxid,
                        value: 500,
                        createdAt: at(2_000),
                        assets: [{ assetId: assetX, amount: 1_000n }],
                    }),
                ]);

                const received = receivedFor(txs, cancelTxid);
                expect(received).toHaveLength(1);
                expect(received[0].amount).toBe(500);
                expect(received[0].assets).toStrictEqual([{ assetId: assetX, amount: 1_000n }]);
                expect(received[0].tag).toBe("gated");
            });

            it("reports nothing at all with the covenant left in the wallet's set", async () => {
                // The worse half of the defect: the movement is entirely
                // asset-side, so both the sats and the units cancel.
                const txs = await ungatedHistory(funding());
                expect(sentOf(txs)).toHaveLength(0);
                expect(rowsFor(txs, fundingTxid)).toHaveLength(0);
            });

            it("dates the deposit from the covenant output, without an indexer call", async () => {
                // With no change output there is nothing of the wallet's left in
                // the funding tx to read the time off. The escrow's own output
                // is that time and is already in hand, so the row must not fall
                // back to the input coin's timestamp — which would be a month
                // stale here — nor pay for a round-trip to learn it.
                const resolveTxCreatedAt = vi.fn(async () => new Map<string, number>());
                const txs = await buildTransactionHistory(
                    funding(),
                    [],
                    new Set(),
                    resolveTxCreatedAt,
                    gatedContracts([offerContract()]),
                );

                expect(resolveTxCreatedAt).not.toHaveBeenCalled();
                expect(sentFor(txs, fundingTxid)[0].createdAt).toBe(at(1_000).getTime());
            });
        });

        describe("what the gate must not swallow", () => {
            it("keeps an arkade row marked genericallySpendable in history", async () => {
                // One coin, standing alone at the contract's script with nothing
                // of the wallet's spending into it: the only shape where "kept"
                // and "dropped" look different. The marker is the only
                // difference between the two runs.
                const deposit = [
                    coin({
                        txid: "third-party-deposit",
                        value: 7_000,
                        script: covenantScript,
                        createdAt: at(1_000),
                    }),
                ];
                const marked = offerContract({
                    metadata: { genericallySpendable: true, kind: "asset-swap-offer" },
                });

                expect(gatedContracts([marked]).size).toBe(0);
                const kept = await history(deposit, marked);
                expect(kept).toHaveLength(1);
                expect(kept[0].type).toBe(TxType.TxReceived);
                expect(kept[0].amount).toBe(7_000);

                // Unmarked, the same coin is escrow: not the wallet's money, so
                // no row. This is the gate's reach beyond swaps — any default-
                // closed `arkade` row funded from outside the wallet loses the
                // receive it used to report.
                expect(gatedContracts([offerContract()]).get(covenantScript)).toBe("arkade");
                expect(await history(deposit)).toHaveLength(0);
            });

            it("leaves an ordinary payment made while an offer is live alone", async () => {
                const paymentTxid = "ordinary-payment-tx";
                const txs = await history([
                    coin({
                        txid: "wallet-coin-ordinary",
                        value: 10_000,
                        ...spentIn(paymentTxid),
                    }),
                    // What the stranger got is not in the wallet's set; the
                    // change is.
                    coin({
                        txid: paymentTxid,
                        vout: 1,
                        value: 3_000,
                        createdAt: at(1_000),
                    }),
                    // A funded covenant sits in the same history and must
                    // not colour a payment it has nothing to do with.
                    coin({
                        txid: "unrelated-funding-tx",
                        value: 6_000,
                        script: covenantScript,
                        createdAt: at(500),
                    }),
                ]);

                const sent = sentFor(txs, paymentTxid);
                expect(sent).toHaveLength(1);
                expect(sent[0].amount).toBe(7_000);
                expect(sent[0].tag).toBe("offchain");
            });

            it("keeps a VTXO with no script in history", async () => {
                // `script` is required on `VirtualCoin`, so the cast is the
                // point rather than a shortcut: it models the shape a legacy
                // repository row actually arrives in, which is why
                // `isVtxoForScript` and the gate both guard on its absence.
                const scriptless = (
                    over: Partial<VirtualCoin> & Pick<VirtualCoin, "txid" | "value">,
                ) => {
                    const { script: _script, ...rest } = coin(over);
                    return rest as VirtualCoin;
                };

                const txs = await history([
                    scriptless({
                        txid: "scriptless-spent",
                        value: 1_000,
                        ...spentIn("scriptless-tx"),
                    }),
                    scriptless({ txid: "scriptless-tx", value: 400, createdAt: at(1_000) }),
                ]);

                // No script means no contract row to judge the coin by, so it is
                // the wallet's own and the ordinary send stands.
                const sent = sentFor(txs, "scriptless-tx");
                expect(sent).toHaveLength(1);
                expect(sent[0].amount).toBe(600);
                expect(sent[0].tag).toBe("offchain");
            });

            it("still records no ghost row for a signer-rotation self-transfer", async () => {
                const arkTxId = "gated-migration-ark-tx";
                const txs = await history([
                    coin({
                        txid: "old-signer-coin",
                        value: 184_875,
                        ...spentIn(arkTxId),
                    }),
                    coin({ txid: arkTxId, value: 184_875, createdAt: at(1_000) }),
                ]);

                expect(sentOf(txs)).toHaveLength(0);
                expect(rowsFor(txs, arkTxId)).toHaveLength(0);
            });

            // [name, ark txid, units spent, units in change, the row's asset amount]
            it.each([
                ["issuance", "gated-issuance", 0n, 500n, 500n],
                ["reissuance", "gated-reissuance", 500n, 900n, 400n],
                ["burn", "gated-burn", 900n, 400n, -500n],
            ] as const)(
                "still records %s as a zero-sat asset row",
                async (_name, arkTxId, spentUnits, changeUnits, expected) => {
                    const txs = await history([
                        coin({
                            txid: `${arkTxId}-input`,
                            value: 1_000,
                            ...spentIn(arkTxId),
                            ...(spentUnits > 0n && {
                                assets: [{ assetId: assetX, amount: spentUnits }],
                            }),
                        }),
                        coin({
                            txid: arkTxId,
                            value: 1_000,
                            createdAt: at(1_000),
                            assets: [{ assetId: assetX, amount: changeUnits }],
                        }),
                    ]);

                    const sent = sentFor(txs, arkTxId);
                    expect(sent).toHaveLength(1);
                    expect(sent[0].amount).toBe(0);
                    expect(sent[0].assets).toStrictEqual([{ assetId: assetX, amount: expected }]);
                    expect(sent[0].tag).toBe("offchain");
                },
            );
        });
    });
    describe("Handles real-life histories correctly", () => {
        transactionHistory.forEach(
            ({
                address,
                vtxos,
                allBoardingTxs,
                commitmentsToIgnore,
                expected,
                expectedBalance,
                sendAllTxTime,
            }) => {
                it(`should handle history from ${address}`, async () => {
                    // `?? 0` matches the pre-batching callback: absent txids resolve to 0.
                    const resolveTxCreatedAt = sendAllTxTime
                        ? (txids: string[]) =>
                              Promise.resolve(
                                  new Map(
                                      txids.map(
                                          (t) => [t, (sendAllTxTime as any)[t] ?? 0] as const,
                                      ),
                                  ),
                              )
                        : undefined;
                    const transactions = await buildTransactionHistory(
                        vtxos.map((_) => ({
                            ..._,
                            createdAt: new Date(_.createdAt),
                        })) as VirtualCoin[],
                        allBoardingTxs as ArkTransaction[],
                        new Set(commitmentsToIgnore),
                        resolveTxCreatedAt,
                    );
                    expect(transactions).toStrictEqual(expected);

                    const balance = transactions.reduce(
                        (acc, tx) =>
                            tx.type === TxType.TxReceived ? acc + tx.amount : acc - tx.amount,
                        0,
                    );
                    expect(balance).toBe(expectedBalance);
                });
            },
        );
    });
});
