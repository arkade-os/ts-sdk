import { describe, it, expect } from "vitest";
import { vtxosToTxs } from "../src/utils/transactionHistory";
import { VirtualCoin, TxType, isSpendable } from "../src/wallet";
import { RestIndexerProvider } from "../src/providers/indexer";
import { RestArkProvider } from "../src/providers/ark";
import { ArkAddress } from "../src/script/address";
import { hex } from "@scure/base";

describe("vtxosToTxs", () => {
    describe("Bug: duplicate sent transactions for split vtxos", () => {
        it("should create a single sent transaction when a vtxo is split into multiple outputs", () => {
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

            const spendable = [resultVtxo0];
            const spent = [spentVtxo];
            const boardingBatchTxids = new Set<string>();

            const transactions = vtxosToTxs(
                spendable,
                spent,
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

            expect(receivedTxs).toHaveLength(0);
            expect(sentTxs).toHaveLength(1);
            expect(sentTxs[0].amount).toBe(500); // 1000 spent - 500 change = 500 sent
            expect(sentTxs[0].key.arkTxid).toBe(arkTxId);
        });

        it("should handle the case where both result vtxos belong to the user (self-transfer/split)", () => {
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

            const spendable = [resultVtxo0, resultVtxo1];
            const spent = [spentVtxo];
            const boardingBatchTxids = new Set<string>();

            const transactions = vtxosToTxs(
                spendable,
                spent,
                boardingBatchTxids
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
        it("should create a receive transaction for a new vtxo", () => {
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

            const transactions = vtxosToTxs(
                spendable,
                spent,
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

    describe("Real-world integration test", () => {
        it("should fetch vtxos from indexer and ensure unique arkTxIds", async () => {
            const indexer = "https://arkade.computer";
            const arkProvider = new RestArkProvider(indexer);
            const indexerProvider = new RestIndexerProvider(indexer);

            const arkAddress =
                "ark1qq4hfssprtcgnjzf8qlw2f78yvjau5kldfugg29k34y7j96q2w4t56dgc5samkp4k49g5exyjk0z4mvpf2c26mwkqkkg6tswhj6laudxnzekfw";
            const decoded = ArkAddress.decode(arkAddress);

            const response = await indexerProvider.getVtxos({
                scripts: [hex.encode(decoded.pkScript)],
            });

            const spendableVtxos = [];
            const spentVtxos = [];

            for (const vtxo of response.vtxos) {
                if (isSpendable(vtxo)) {
                    spendableVtxos.push(vtxo);
                } else {
                    spentVtxos.push(vtxo);
                }
            }

            // convert VTXOs to offchain transactions
            const offchainTxs = vtxosToTxs(
                spendableVtxos,
                spentVtxos,
                new Set<string>()
            );

            const txs = [...offchainTxs];

            // sort transactions by creation time in descending order (newest first)
            txs.sort(
                // place createdAt = 0 (unconfirmed txs) first, then descending
                (a, b) => {
                    if (a.createdAt === 0) return -1;
                    if (b.createdAt === 0) return 1;
                    return b.createdAt - a.createdAt;
                }
            );

            console.log(JSON.stringify(Array.from(txs)));
            // Each transaction should have a unique arkTxId
            const arkTxIds = new Set<string>();
            for (const tx of txs) {
                if (tx.key.arkTxid) {
                    arkTxIds.add(tx.key.arkTxid);
                }
            }

            // Each transaction should have a unique arkTxId
            expect(arkTxIds.size).toBe(
                txs.filter((tx) => tx.key.arkTxid).length
            );

            // Verify we have some transactions
            expect(txs.length).toBeGreaterThan(0);
        });
    });
});
