import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IndexedDBStorageAdapter } from "../../src/storage/indexedDB";
import { WalletRepositoryImpl } from "../../src/repositories/migrations/walletRepositoryImpl";
import {
    type ArkTransaction,
    type ExtendedCoin,
    type ExtendedVirtualCoin,
    IndexedDBWalletRepository,
    InMemoryWalletRepository,
    migrateWalletRepository,
    type TapLeafScript,
    TxType,
} from "../../src";
import { TaprootControlBlock } from "@scure/btc-signer";
import { hex } from "@scure/base";
import {
    createMockTransaction,
    createMockUtxo,
    createMockVtxo,
    RepositoryTestItem,
} from "../storage.test";
import { WalletRepository, WalletState } from "../../src/repositories";

const walletRepositoryImplementations: Array<
    RepositoryTestItem<WalletRepository>
> = [
    {
        name: "InMemoryWalletRepository",
        factory: async () => new InMemoryWalletRepository(),
    },
    {
        name: "IndexedDBWalletRepository",
        factory: async () => new IndexedDBWalletRepository(),
    },
];

// WalletRepository tests
describe.each(walletRepositoryImplementations)(
    "WalletRepository: $name",
    ({ factory }) => {
        let repository: WalletRepository;
        const testAddress = "test-address-123";

        beforeEach(async () => {
            repository = await factory();
        });

        afterEach(async () => {
            repository?.clear();
            await repository?.[Symbol.asyncDispose]();
        });

        describe("VTXO management", () => {
            it("should return empty array when no VTXOs exist", async () => {
                const vtxos = await repository.getVtxos(testAddress);
                expect(vtxos).toEqual([]);
            });

            it("should save and retrieve VTXOs", async () => {
                const vtxo1 = createMockVtxo("tx1", 0, 10000);
                const vtxo2 = createMockVtxo("tx2", 1, 20000);

                await repository.saveVtxos(testAddress, [vtxo1, vtxo2]);
                const retrieved = await repository.getVtxos(testAddress);

                expect(retrieved).toHaveLength(2);
                expect(retrieved[0].txid).toBe("tx1");
                expect(retrieved[0].vout).toBe(0);
                expect(retrieved[0].value).toBe(10000);
                expect(retrieved[1].txid).toBe("tx2");
                expect(retrieved[1].vout).toBe(1);
                expect(retrieved[1].value).toBe(20000);
            });

            it("should update existing VTXO when saving with same txid/vout", async () => {
                const vtxo1 = createMockVtxo("tx1", 0, 10000);
                await repository.saveVtxos(testAddress, [vtxo1]);

                const vtxo1Updated = createMockVtxo("tx1", 0, 15000);
                await repository.saveVtxos(testAddress, [vtxo1Updated]);

                const retrieved = await repository.getVtxos(testAddress);
                expect(retrieved).toHaveLength(1);
                expect(retrieved[0].value).toBe(15000);
            });

            it("should clear all VTXOs for an address", async () => {
                const vtxo1 = createMockVtxo("tx1", 0, 10000);
                await repository.saveVtxos(testAddress, [vtxo1]);

                await repository.deleteVtxos(testAddress);
                const retrieved = await repository.getVtxos(testAddress);

                expect(retrieved).toEqual([]);
            });

            it("should handle multiple addresses independently", async () => {
                const address1 = "address-1";
                const address2 = "address-2";
                const vtxo1 = createMockVtxo("tx1", 0, 10000);
                const vtxo2 = createMockVtxo("tx2", 0, 20000);

                await repository.saveVtxos(address1, [vtxo1]);
                await repository.saveVtxos(address2, [vtxo2]);

                const retrieved1 = await repository.getVtxos(address1);
                const retrieved2 = await repository.getVtxos(address2);

                expect(retrieved1).toHaveLength(1);
                expect(retrieved1[0].txid).toBe("tx1");
                expect(retrieved2).toHaveLength(1);
                expect(retrieved2[0].txid).toBe("tx2");
            });
        });

        describe("UTXO management", () => {
            it("should return empty array when no UTXOs exist", async () => {
                const utxos = await repository.getUtxos(testAddress);
                expect(utxos).toEqual([]);
            });

            it("should save and retrieve UTXOs", async () => {
                const utxo1 = createMockUtxo("tx1", 0, 10000);
                const utxo2 = createMockUtxo("tx2", 1, 20000);

                await repository.saveUtxos(testAddress, [utxo1, utxo2]);
                const retrieved = await repository.getUtxos(testAddress);

                expect(retrieved).toHaveLength(2);
                expect(retrieved[0].txid).toBe("tx1");
                expect(retrieved[0].vout).toBe(0);
                expect(retrieved[0].value).toBe(10000);
            });

            it("should update existing UTXO when saving with same txid/vout", async () => {
                const utxo1 = createMockUtxo("tx1", 0, 10000);
                await repository.saveUtxos(testAddress, [utxo1]);

                const utxo1Updated = createMockUtxo("tx1", 0, 15000);
                await repository.saveUtxos(testAddress, [utxo1Updated]);

                const retrieved = await repository.getUtxos(testAddress);
                expect(retrieved).toHaveLength(1);
                expect(retrieved[0].value).toBe(15000);
            });

            it("should clear all UTXOs for an address", async () => {
                const utxo1 = createMockUtxo("tx1", 0, 10000);
                await repository.saveUtxos(testAddress, [utxo1]);

                await repository.deleteUtxos(testAddress);
                const retrieved = await repository.getUtxos(testAddress);

                expect(retrieved).toEqual([]);
            });
        });

        describe("Transaction history", () => {
            it("should return empty array when no transactions exist", async () => {
                const txs = await repository.getTransactionHistory(testAddress);
                expect(txs).toEqual([]);
            });

            it("should save and retrieve transactions", async () => {
                const tx1 = createMockTransaction(
                    { arkTxid: "atx1" },
                    "SENT" as TxType,
                    10000
                );
                const tx2 = createMockTransaction(
                    { boardingTxid: "btx2" },
                    "RECEIVED" as TxType,
                    20000
                );

                const tx3 = createMockTransaction(
                    { commitmentTxid: "ctx3" },
                    "RECEIVED" as TxType,
                    30000
                );

                await repository.saveTransactions(testAddress, [tx1, tx2, tx3]);
                const retrieved =
                    await repository.getTransactionHistory(testAddress);

                expect(retrieved).toHaveLength(3);
                expect(retrieved[0].key.arkTxid).toBe("atx1");
                expect(retrieved[0].type).toBe("SENT");
                expect(retrieved[1].key.boardingTxid).toBe("btx2");
                expect(retrieved[1].type).toBe("RECEIVED");
                expect(retrieved[2].key.commitmentTxid).toBe("ctx3");
                expect(retrieved[2].type).toBe("RECEIVED");
            });

            it("should update existing transaction when saving with same key", async () => {
                const tx1 = createMockTransaction(
                    { arkTxid: "atx1" },
                    "SENT" as TxType,
                    10000
                );
                await repository.saveTransactions(testAddress, [tx1]);

                const tx1Updated = createMockTransaction(
                    { arkTxid: "atx1" },
                    "SENT" as TxType,
                    15000
                );
                await repository.saveTransactions(testAddress, [tx1Updated]);

                const retrieved =
                    await repository.getTransactionHistory(testAddress);
                expect(retrieved).toHaveLength(1);
                expect(retrieved[0].amount).toBe(15000);
            });

            it("should clear all transactions for an address", async () => {
                const tx1 = createMockTransaction(
                    { arkTxid: "atx1" },
                    "SENT" as TxType,
                    10000
                );
                await repository.saveTransactions(testAddress, [tx1]);

                await repository.deleteTransactions(testAddress);
                const retrieved =
                    await repository.getTransactionHistory(testAddress);

                expect(retrieved).toEqual([]);
            });
        });

        describe("Wallet state", () => {
            it("should return null when no wallet state exists", async () => {
                const state = await repository.getWalletState();
                expect(state).toBeNull();
            });

            it("should save and retrieve wallet state", async () => {
                const state: WalletState = {
                    lastSyncTime: Date.now(),
                    settings: { theme: "dark" },
                };

                await repository.saveWalletState(state);
                const retrieved = await repository.getWalletState();

                expect(retrieved).toEqual(state);
                expect(retrieved?.lastSyncTime).toBe(state.lastSyncTime);
                expect(retrieved?.settings).toEqual(state.settings);
            });

            it("should update existing wallet state", async () => {
                const state1: WalletState = {
                    lastSyncTime: Date.now(),
                    settings: { theme: "dark" },
                };
                await repository.saveWalletState(state1);

                const state2: WalletState = {
                    lastSyncTime: Date.now() + 1000,
                    settings: { theme: "light" },
                };
                await repository.saveWalletState(state2);

                const retrieved = await repository.getWalletState();
                expect(retrieved?.settings?.theme).toBe("light");
            });
        });
    }
);
