import { describe, it, expect, beforeEach, vi } from "vitest";
import { hex } from "@scure/base";
import { TaprootControlBlock } from "@scure/btc-signer";
import {
    WalletRepository,
    WalletState,
} from "../src/repositories/walletRepository";
import { ContractRepository } from "../src/repositories/contractRepository";
import { IndexedDBWalletRepository } from "../src/repositories/indexedDB/walletRepository";
import { IndexedDBContractRepository } from "../src/repositories/indexedDB/contractRepository";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import { InMemoryContractRepository } from "../src/repositories/inMemory/contractRepository";
import {
    migrateWalletRepository,
    migrateContractRepository,
} from "../src/repositories/migrations/fromStorageAdapter";
import type {
    ExtendedVirtualCoin,
    ExtendedCoin,
    ArkTransaction,
    TxType,
} from "../src/wallet";
import type { TapLeafScript } from "../src/script/base";
import { IndexedDBStorageAdapter } from "../src/storage/indexedDB";
import { WalletRepositoryImpl } from "../src/repositories/migrations/walletRepositoryImpl";
import { ContractRepositoryImpl } from "../src/repositories/migrations/contractRepositoryImpl";
import { InMemoryStorageAdapter } from "../src/storage/inMemory";
import { readFile } from "node:fs/promises";

type RepositoryTestItem<T> = {
    name: string;
    factory: () => Promise<T>;
};

const walletRepositoryImplementations: Array<
    RepositoryTestItem<WalletRepository>
> = [
    {
        name: "InMemoryWalletRepository",
        factory: async () => new InMemoryWalletRepository(),
    },
    {
        name: "WalletRepositoryImpl (IndexedDBStorage)",
        factory: async () => {
            const dbName = getUniqueDbName("wallet-repo");
            const storage = new IndexedDBStorageAdapter(dbName);
            return new WalletRepositoryImpl(storage);
        },
    },
    {
        name: "IndexedDBWalletRepository",
        factory: async () => {
            const dbName = getUniqueDbName("wallet-idb");
            return new IndexedDBWalletRepository(dbName);
        },
    },
];

const contractRepositoryImplementations: Array<
    RepositoryTestItem<ContractRepository>
> = [
    {
        name: "InMemoryContractRepository",
        factory: async () => new InMemoryContractRepository(),
    },
    {
        name: "ContractRepositoryImpl (IndexedDBStorage)",
        factory: async () => {
            const dbName = getUniqueDbName("contract-repo");
            const storage = new IndexedDBStorageAdapter(dbName);
            return new ContractRepositoryImpl(storage);
        },
    },
    {
        name: "IndexedDBContractRepository",
        factory: async () => {
            const dbName = getUniqueDbName("contract-idb");
            return new IndexedDBContractRepository(dbName);
        },
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

                await repository.clearVtxos(testAddress);
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

                await repository.clearUtxos(testAddress);
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

                await repository.clearTransactions(testAddress);
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

// ContractRepository tests
describe.each(contractRepositoryImplementations)(
    "ContractRepository: $name",
    ({ factory }) => {
        let repository: ContractRepository;
        const testContractId = "test-contract-123";
        const testKey = "test-key";

        beforeEach(async () => {
            repository = await factory();
        });

        describe("Contract data management", () => {
            it("should return null when contract data does not exist", async () => {
                const data = await repository.getContractData<string>(
                    testContractId,
                    testKey
                );
                expect(data).toBeNull();
            });

            it("should save and retrieve contract data", async () => {
                const testData = { status: "active", amount: 1000 };

                await repository.setContractData(
                    testContractId,
                    testKey,
                    testData
                );
                const retrieved = await repository.getContractData<{
                    status: string;
                    amount: number;
                }>(testContractId, testKey);

                expect(retrieved).toEqual(testData);
            });

            it("should handle different data types", async () => {
                // String
                await repository.setContractData(
                    testContractId,
                    "string-key",
                    "test"
                );
                const str = await repository.getContractData<string>(
                    testContractId,
                    "string-key"
                );
                expect(str).toBe("test");

                // Number
                await repository.setContractData(
                    testContractId,
                    "number-key",
                    42
                );
                const num = await repository.getContractData<number>(
                    testContractId,
                    "number-key"
                );
                expect(num).toBe(42);

                // Object
                const obj = { nested: { value: "test" } };
                await repository.setContractData(
                    testContractId,
                    "object-key",
                    obj
                );
                const retrieved = await repository.getContractData<typeof obj>(
                    testContractId,
                    "object-key"
                );
                expect(retrieved).toEqual(obj);
            });

            it("should handle multiple contracts independently", async () => {
                const contract1 = "contract-1";
                const contract2 = "contract-2";

                await repository.setContractData(contract1, testKey, "data1");
                await repository.setContractData(contract2, testKey, "data2");

                const data1 = await repository.getContractData<string>(
                    contract1,
                    testKey
                );
                const data2 = await repository.getContractData<string>(
                    contract2,
                    testKey
                );

                expect(data1).toBe("data1");
                expect(data2).toBe("data2");
            });

            it("should delete contract data", async () => {
                await repository.setContractData(
                    testContractId,
                    testKey,
                    "test"
                );
                await repository.deleteContractData(testContractId, testKey);

                const retrieved = await repository.getContractData<string>(
                    testContractId,
                    testKey
                );
                expect(retrieved).toBeNull();
            });

            it("should clear all contract data", async () => {
                await repository.setContractData(
                    testContractId,
                    "key1",
                    "data1"
                );
                await repository.setContractData(
                    testContractId,
                    "key2",
                    "data2"
                );
                await repository.saveToContractCollection(
                    "swaps",
                    { id: "1" },
                    "id"
                );

                await repository.clearContractData();

                const data1 = await repository.getContractData<string>(
                    testContractId,
                    "key1"
                );
                const data2 = await repository.getContractData<string>(
                    testContractId,
                    "key2"
                );
                const collection =
                    await repository.getContractCollection("swaps");

                expect(data1).toBeNull();
                expect(data2).toBeNull();
                expect(collection).toEqual([]);
            });
        });

        describe("Contract collections", () => {
            it("should return empty array when collection does not exist", async () => {
                const collection = await repository.getContractCollection<{
                    id: string;
                }>("swaps");
                expect(collection).toEqual([]);
            });

            it("should save and retrieve collection items", async () => {
                const item1 = { id: "swap-1", amount: 1000, type: "reverse" };
                const item2 = { id: "swap-2", amount: 2000, type: "normal" };

                await repository.saveToContractCollection("swaps", item1, "id");
                await repository.saveToContractCollection("swaps", item2, "id");

                const collection =
                    await repository.getContractCollection<typeof item1>(
                        "swaps"
                    );

                expect(collection).toHaveLength(2);
                expect(collection[0].id).toBe("swap-1");
                expect(collection[1].id).toBe("swap-2");
            });

            it("should update existing item in collection", async () => {
                const item1 = { id: "swap-1", amount: 1000 };
                await repository.saveToContractCollection("swaps", item1, "id");

                const item1Updated = { id: "swap-1", amount: 1500 };
                await repository.saveToContractCollection(
                    "swaps",
                    item1Updated,
                    "id"
                );

                const collection =
                    await repository.getContractCollection<typeof item1>(
                        "swaps"
                    );
                expect(collection).toHaveLength(1);
                expect(collection[0].amount).toBe(1500);
            });

            it("should remove item from collection", async () => {
                type SwapItem = { id: string; amount: number };
                const item1: SwapItem = { id: "swap-1", amount: 1000 };
                const item2: SwapItem = { id: "swap-2", amount: 2000 };

                await repository.saveToContractCollection<SwapItem, "id">(
                    "swaps",
                    item1,
                    "id"
                );
                await repository.saveToContractCollection<SwapItem, "id">(
                    "swaps",
                    item2,
                    "id"
                );

                await repository.removeFromContractCollection<SwapItem, "id">(
                    "swaps",
                    "swap-1",
                    "id"
                );

                const collection =
                    await repository.getContractCollection<SwapItem>("swaps");
                expect(collection).toHaveLength(1);
                expect(collection[0].id).toBe("swap-2");
            });

            it("should handle multiple collections independently", async () => {
                const swap1 = { id: "swap-1", amount: 1000 };
                const order1 = { id: "order-1", price: 500 };

                await repository.saveToContractCollection("swaps", swap1, "id");
                await repository.saveToContractCollection(
                    "orders",
                    order1,
                    "id"
                );

                const swaps =
                    await repository.getContractCollection<typeof swap1>(
                        "swaps"
                    );
                const orders =
                    await repository.getContractCollection<typeof order1>(
                        "orders"
                    );

                expect(swaps).toHaveLength(1);
                expect(swaps[0].id).toBe("swap-1");
                expect(orders).toHaveLength(1);
                expect(orders[0].id).toBe("order-1");
            });

            it("should throw error when item missing id field", async () => {
                type SwapItem = { id: string; amount: number };
                const item = { amount: 1000 } as SwapItem; // missing id field

                await expect(
                    repository.saveToContractCollection<SwapItem, "id">(
                        "swaps",
                        item,
                        "id"
                    )
                ).rejects.toThrow();
            });

            it("should throw error when removing with invalid id", async () => {
                type SwapItem = { id: string; amount: number };
                await expect(
                    repository.removeFromContractCollection<SwapItem, "id">(
                        "swaps",
                        null as unknown as string,
                        "id"
                    )
                ).rejects.toThrow();
            });
        });
    }
);

describe("IndexedDB migrations", () => {
    it("should migrate wallet data from StorageAdapter to IndexedDB format", async () => {
        const oldDbName = getUniqueDbName("wallet-migration-old");
        const newDbName = getUniqueDbName("wallet-migration-new");

        const oldStorage = new IndexedDBStorageAdapter(oldDbName, 1);
        const walletRepoV1 = new WalletRepositoryImpl(oldStorage);

        const testAddress1 = "test-address-1";
        const testAddress2 = "test-address-2";

        const vtxo1 = createMockVtxo("txvtxo1", 0, 10000);
        const vtxo2 = createMockVtxo("txvtxo2", 1, 20000);
        const vtxo3 = createMockVtxo("txvtxo3", 0, 30000);
        const utxo1 = createMockUtxo("txutxo1", 0, 10000);
        const utxo2 = createMockUtxo("txutxo2", 1, 20000);
        const tx1 = createMockTransaction(
            { boardingTxid: "btx1" },
            "SENT" as TxType,
            10000
        );
        const tx2 = createMockTransaction(
            { commitmentTxid: "ctx2" },
            "RECEIVED" as TxType,
            20000
        );
        const tx3 = createMockTransaction(
            { arkTxid: "atx3" },
            "SENT" as TxType,
            30000
        );
        const walletState = {
            lastSyncTime: Date.now(),
            settings: { theme: "dark" },
        };
        const commitmentTxsFixture = [
            { txid: "commitment-tx-1", when: 1768251194 },
            { txid: "commitment-tx-2", when: 1768489720 },
        ];

        await walletRepoV1.saveVtxos(testAddress1, [vtxo1, vtxo2]);
        await walletRepoV1.saveVtxos(testAddress2, [vtxo3]);
        await walletRepoV1.saveUtxos(testAddress1, [utxo1]);
        await walletRepoV1.saveUtxos(testAddress2, [utxo2]);
        await walletRepoV1.saveTransactions(testAddress1, [tx1, tx2]);
        await walletRepoV1.saveTransactions(testAddress2, [tx3]);
        await walletRepoV1.saveWalletState(walletState);
        await oldStorage.setItem(
            "collection:commitmentTxs",
            JSON.stringify(commitmentTxsFixture)
        );

        const walletRepoV2 = new IndexedDBWalletRepository(newDbName);

        await migrateWalletRepository(oldStorage, walletRepoV2, [
            testAddress1,
            testAddress2,
        ]);

        const vtxos1 = await walletRepoV2.getVtxos(testAddress1);
        expect(vtxos1).toHaveLength(2);
        expect(vtxos1[0].txid).toBe("txvtxo1");
        expect(vtxos1[0].value).toBe(10000);
        expect(vtxos1[1].txid).toBe("txvtxo2");
        expect(vtxos1[1].value).toBe(20000);

        const vtxos2 = await walletRepoV2.getVtxos(testAddress2);
        expect(vtxos2).toHaveLength(1);
        expect(vtxos2[0].txid).toBe("txvtxo3");
        expect(vtxos2[0].value).toBe(30000);

        const utxos1 = await walletRepoV2.getUtxos(testAddress1);
        expect(utxos1).toHaveLength(1);
        expect(utxos1[0].txid).toBe("txutxo1");
        expect(utxos1[0].value).toBe(10000);

        const utxos2 = await walletRepoV2.getUtxos(testAddress2);
        expect(utxos2).toHaveLength(1);
        expect(utxos2[0].txid).toBe("txutxo2");
        expect(utxos2[0].value).toBe(20000);

        const txs1 = await walletRepoV2.getTransactionHistory(testAddress1);
        expect(txs1).toHaveLength(2);
        expect(txs1[0].key.boardingTxid).toBe("btx1");
        expect(txs1[0].type).toBe("SENT");
        expect(txs1[0].amount).toBe(10000);
        expect(txs1[1].key.commitmentTxid).toBe("ctx2");
        expect(txs1[1].type).toBe("RECEIVED");
        expect(txs1[1].amount).toBe(20000);

        const txs2 = await walletRepoV2.getTransactionHistory(testAddress2);
        expect(txs2).toHaveLength(1);
        expect(txs2[0].key.arkTxid).toBe("atx3");
        expect(txs2[0].type).toBe("SENT");
        expect(txs2[0].amount).toBe(30000);

        const walletState2 = await walletRepoV2.getWalletState();
        expect(walletState2).not.toBeNull();
        expect(walletState2?.settings?.theme).toBe("dark");
        expect(walletState2?.lastSyncTime).toBe(walletState.lastSyncTime);

        const commitmentTxs1 =
            await walletRepoV2.getCommitmentTxs("commitment-tx-1");
        expect(commitmentTxs1).toEqual([commitmentTxsFixture[0]]);
        const commitmentTxs2 =
            await walletRepoV2.getCommitmentTxs("commitment-tx-2");
        expect(commitmentTxs2).toEqual([commitmentTxsFixture[1]]);
    });

    it("should migrate contract data from StorageAdapter to IndexedDB format", async () => {
        const fixturePath = new URL(
            "./fixtures/v1-db-dump.json",
            import.meta.url
        );
        const fixtureRaw = await readFile(fixturePath, "utf8");
        const fixture = JSON.parse(fixtureRaw) as Record<string, string>;

        const storage = new InMemoryStorageAdapter();
        await Promise.all(
            Object.entries(fixture).map(([key, value]) =>
                storage.setItem(key, value)
            )
        );

        const dbName = getUniqueDbName("contract-migration");
        const repo = new IndexedDBContractRepository(dbName);
        await migrateContractRepository(storage, repo);

        const reverseSwapsFixture = JSON.parse(
            fixture["collection:reverseSwaps"]
        );
        const reverseSwaps = await repo.getContractCollection("reverseSwaps");
        expect(reverseSwaps).toEqual(reverseSwapsFixture);

        const submarineSwapsFixture = JSON.parse(
            fixture["collection:submarineSwaps"]
        );
        const submarineSwaps =
            await repo.getContractCollection("submarineSwaps");
        expect(submarineSwaps).toEqual(submarineSwapsFixture);

        const migration = await storage.getItem(
            "migration-from-storage-adapter-contract"
        );
        expect(migration).toBe("done");
    });

    it("should not migrate if migration already completed", async () => {
        const oldDbName = getUniqueDbName("wallet-migration-skip-old");
        const newDbName = getUniqueDbName("wallet-migration-skip-new");

        const oldStorage = new IndexedDBStorageAdapter(oldDbName, 1);
        const walletRepoV1 = new WalletRepositoryImpl(oldStorage);
        const testAddress = "test-address";

        const vtxo1 = createMockVtxo("tx1", 0, 10000);
        await walletRepoV1.saveVtxos(testAddress, [vtxo1]);

        await oldStorage.setItem(
            "migration-from-storage-adapter-wallet",
            "done"
        );

        const walletRepoV2 = new IndexedDBWalletRepository(newDbName);

        await migrateWalletRepository(oldStorage, walletRepoV2, [testAddress]);

        const vtxos = await walletRepoV2.getVtxos(testAddress);
        expect(vtxos).toHaveLength(0);
    });

    it("should not migrate if the legacy DB doesn't exist", async () => {
        const oldDbName = getUniqueDbName("wallet-migration-skip-old");
        const newDbName = getUniqueDbName("wallet-migration-skip-new");

        // In test environment the DB is created new and will emit `onupgradeneeded` which
        // will create the object store.
        // In production this doesn't happen and we end up accessing a non-existing object store.
        // This is why we simulate exactly this case here.
        const oldStorage = {
            getItem: () => {
                throw new Error(
                    "Failed to execute 'transaction' on 'IDBDatabase': One of the specified object stores was not found"
                );
            },
        } as any;
        const testAddress = "test-address";

        const walletRepoV2 = {
            getVtxos: vi.fn(),
            saveVtxos: vi.fn(),
        } as any;

        await migrateWalletRepository(oldStorage, walletRepoV2, [testAddress]);
        expect(walletRepoV2.getVtxos).not.toHaveBeenCalled();
        expect(walletRepoV2.saveVtxos).not.toHaveBeenCalled();

        const contractRepoV2 = {
            getContractCollection: vi.fn(),
            saveToContractCollection: vi.fn(),
        };
        await migrateContractRepository(oldStorage, contractRepoV2 as any);
        expect(contractRepoV2.getContractCollection).not.toHaveBeenCalled();
        expect(contractRepoV2.saveToContractCollection).not.toHaveBeenCalled();
    });
});

function createMockTapLeafScript(): TapLeafScript {
    const version = 0xc0;
    const internalKey = new Uint8Array(32).fill(1);
    const controlBlockBytes = new Uint8Array([version, ...internalKey]);
    const controlBlock = TaprootControlBlock.decode(controlBlockBytes);
    const script = new Uint8Array(20).fill(2);
    return [controlBlock, script];
}

function createMockVtxo(
    txid: string,
    vout: number,
    value: number
): ExtendedVirtualCoin {
    const tapLeaf = createMockTapLeafScript();
    return {
        txid,
        vout,
        value,
        status: {
            confirmed: true,
            block_height: 100,
            block_hash: hex.encode(new Uint8Array(32).fill(1)),
            block_time: Date.now(),
        },
        virtualStatus: {
            state: "preconfirmed",
        },
        createdAt: new Date(),
        isUnrolled: false,
        isSpent: false,
        forfeitTapLeafScript: tapLeaf,
        intentTapLeafScript: tapLeaf,
        tapTree: new Uint8Array(32).fill(3),
    };
}

function createMockUtxo(
    txid: string,
    vout: number,
    value: number
): ExtendedCoin {
    const tapLeaf = createMockTapLeafScript();
    return {
        txid,
        vout,
        value,
        status: {
            confirmed: true,
            block_height: 100,
            block_hash: hex.encode(new Uint8Array(32).fill(1)),
            block_time: Date.now(),
        },
        forfeitTapLeafScript: tapLeaf,
        intentTapLeafScript: tapLeaf,
        tapTree: new Uint8Array(32).fill(3),
    };
}

let txCounter = 0;
function createMockTransaction(
    key: { boardingTxid?: string; commitmentTxid?: string; arkTxid?: string },
    type: TxType,
    amount: number
): ArkTransaction {
    if (!key.boardingTxid && !key.commitmentTxid && !key.arkTxid) {
        throw new Error(
            "Key must have one of boardingTxid, commitmentTxid, or arkTxid"
        );
    }
    return {
        key: {
            boardingTxid: key.boardingTxid || "",
            commitmentTxid: key.commitmentTxid || "",
            arkTxid: key.arkTxid || "",
        },
        type,
        amount,
        settled: false,
        createdAt: Date.now() + txCounter++,
    };
}

let dbCounter = 0;
function getUniqueDbName(prefix: string): string {
    return `${prefix}-test-${Date.now()}-${++dbCounter}`;
}
