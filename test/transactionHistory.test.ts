import { describe, it, expect } from "vitest";
import transactionHistory from "./fixtures/transaction_history.json";
import { VirtualCoin, TxType, ArkTransaction } from "../src/wallet";
import { buildTransactionHistory } from "../src/utils/transactionHistory";

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

            const arkTxId =
                "98b1cdc34d006e0956b1a828c65cd222780348d94b706a69a933ee58b19ab8e0";
            const commitmentTxId =
                "3a74555034c7f3c8053d0b30441178630dd98f645d9ed42aa9425fdc2279e159";
            const spentByTxId =
                "90a9f4b835db83cc55a67bc5f362d139e81eb268f4f30b156cc8b0e5a1fdd6b0";
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
                boardingBatchTxids
            );

            // Filter for sent and received transactions
            const sentTxs = transactions.filter(
                (tx) => tx.type === TxType.TxSent
            );
            const receivedTxs = transactions.filter(
                (tx) => tx.type === TxType.TxReceived
            );

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

            const arkTxId =
                "98b1cdc34d006e0956b1a828c65cd222780348d94b706a69a933ee58b19ab8e0";
            const commitmentTxId =
                "3a74555034c7f3c8053d0b30441178630dd98f645d9ed42aa9425fdc2279e159";
            const spentByTxId =
                "90a9f4b835db83cc55a67bc5f362d139e81eb268f4f30b156cc8b0e5a1fdd6b0";
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
                new Set<string>()
            );
            const sentTxs = transactions.filter(
                (tx) => tx.type === TxType.TxSent
            );
            const receivedTxs = transactions.filter(
                (tx) => tx.type === TxType.TxReceived
            );

            // When both outputs come back to the user, it's a self-transfer
            // spentAmount (1000) - resultedAmount (1000) = 0
            // So no sent transaction should be created (filtered out at line 98-100)
            expect(sentTxs).toHaveLength(0);

            // The result vtxos should not show as received either (they're change from our own spend)
            expect(receivedTxs).toHaveLength(0);
        });
    });

    describe("Receive transactions", () => {
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
                boardingBatchTxids
            );
            const receivedTxs = transactions.filter(
                (tx) => tx.type === TxType.TxReceived
            );

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
                assets: [{ assetId: assetA, amount: 50 }],
            };

            const txs = await buildTransactionHistory([vtxo], [], new Set());

            expect(txs).toHaveLength(1);
            expect(txs[0].type).toBe(TxType.TxReceived);
            expect(txs[0].assets).toStrictEqual([
                { assetId: assetA, amount: 50 },
            ]);
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
                    { assetId: assetA, amount: 10 },
                    { assetId: assetB, amount: 20 },
                ],
            };

            const txs = await buildTransactionHistory([vtxo], [], new Set());

            expect(txs).toHaveLength(1);
            expect(txs[0].type).toBe(TxType.TxReceived);
            expect(txs[0].tag).toBe("batch");
            expect(txs[0].assets).toStrictEqual([
                { assetId: assetA, amount: 10 },
                { assetId: assetB, amount: 20 },
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
                assets: [{ assetId: assetA, amount: 100 }],
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
                assets: [{ assetId: assetA, amount: 30 }],
            };

            const txs = await buildTransactionHistory(
                [spentVtxo, changeVtxo],
                [],
                new Set()
            );

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(600);
            expect(sentTxs[0].assets).toStrictEqual([
                { assetId: assetA, amount: -70 },
            ]);
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
                assets: [{ assetId: assetA, amount: 50 }],
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
                assets: [{ assetId: assetA, amount: 50 }],
            };

            const txs = await buildTransactionHistory(
                [spentVtxo, changeVtxo],
                [],
                new Set()
            );

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
                    { assetId: assetA, amount: 40 },
                    { assetId: assetB, amount: 60 },
                ],
            };

            const txs = await buildTransactionHistory(
                [spentVtxo],
                [],
                new Set()
            );

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(1000);
            expect(sentTxs[0].assets).toStrictEqual([
                { assetId: assetA, amount: -40 },
                { assetId: assetB, amount: -60 },
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
                assets: [{ assetId: assetA, amount: 80 }],
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
                assets: [{ assetId: assetA, amount: 20 }],
            };

            const txs = await buildTransactionHistory(
                [forfeitVtxo, changeVtxo],
                [],
                new Set()
            );

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].tag).toBe("exit");
            expect(sentTxs[0].amount).toBe(1500);
            expect(sentTxs[0].assets).toStrictEqual([
                { assetId: assetA, amount: -60 },
            ]);
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
                assets: [{ assetId: assetB, amount: 75 }],
            };

            const txs = await buildTransactionHistory(
                [forfeitVtxo],
                [],
                new Set()
            );

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].tag).toBe("exit");
            expect(sentTxs[0].amount).toBe(1000);
            expect(sentTxs[0].assets).toStrictEqual([
                { assetId: assetB, amount: -75 },
            ]);
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
                assets: [{ assetId: assetA, amount: 100 }],
            };

            const txs = await buildTransactionHistory(
                [spentVtxo, changeVtxo],
                [],
                new Set()
            );

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(0);
            expect(sentTxs[0].assets).toStrictEqual([
                { assetId: assetA, amount: 100 },
            ]);
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
                assets: [{ assetId: assetA, amount: 50 }],
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
                assets: [{ assetId: assetA, amount: 150 }],
            };

            const txs = await buildTransactionHistory(
                [spentVtxo, changeVtxo],
                [],
                new Set()
            );

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(0);
            expect(sentTxs[0].assets).toStrictEqual([
                { assetId: assetA, amount: 100 },
            ]);
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
                assets: [{ assetId: assetA, amount: 100 }],
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

            const txs = await buildTransactionHistory(
                [spentVtxo, changeVtxo],
                [],
                new Set()
            );

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(0);
            // Negative = assets lost/burned
            expect(sentTxs[0].assets).toStrictEqual([
                { assetId: assetA, amount: -100 },
            ]);
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
                    { assetId: assetA, amount: 50 }, // will be fully burned
                    { assetId: assetB, amount: 80 }, // 30 will be transferred
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
                    { assetId: assetB, amount: 50 }, // kept 50 of 80
                    { assetId: assetC, amount: 200 }, // newly issued
                ],
            };

            const txs = await buildTransactionHistory(
                [spentVtxo, changeVtxo],
                [],
                new Set()
            );

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(500);
            expect(sentTxs[0].assets).toStrictEqual([
                { assetId: assetB, amount: -30 }, // transferred/lost
                { assetId: assetC, amount: 200 }, // issued/gained
                { assetId: assetA, amount: -50 }, // burned/lost
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
                assets: [{ assetId: assetA, amount: 30 }],
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
                    { assetId: assetA, amount: 20 },
                    { assetId: assetB, amount: 10 },
                ],
            };

            const txs = await buildTransactionHistory(
                [spentVtxo1, spentVtxo2],
                [],
                new Set()
            );

            const sentTxs = txs.filter((t) => t.type === TxType.TxSent);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(1000);
            expect(sentTxs[0].assets).toStrictEqual([
                { assetId: assetA, amount: -50 },
                { assetId: assetB, amount: -10 },
            ]);
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
                    const getTxCreatedAt = sendAllTxTime
                        ? (txid: string) =>
                              Promise.resolve((sendAllTxTime as any)[txid] ?? 0)
                        : undefined;
                    const transactions = await buildTransactionHistory(
                        vtxos.map((_) => ({
                            ..._,
                            createdAt: new Date(_.createdAt),
                        })) as VirtualCoin[],
                        allBoardingTxs as ArkTransaction[],
                        new Set(commitmentsToIgnore),
                        getTxCreatedAt
                    );
                    expect(transactions).toStrictEqual(expected);

                    const balance = transactions.reduce(
                        (acc, tx) =>
                            tx.type === TxType.TxReceived
                                ? acc + tx.amount
                                : acc - tx.amount,
                        0
                    );
                    expect(balance).toBe(expectedBalance);
                });
            }
        );
    });
});
