import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import { TaprootControlBlock } from "@scure/btc-signer";
import {
    WalletRepository,
    WalletRepositoryImpl,
    WalletState,
} from "../src/repositories/walletRepository";
import {
    ContractRepository,
    ContractRepositoryImpl,
} from "../src/repositories/contractRepository";
import { IndexedDBWalletRepository } from "../src/repositories/indexedDB/walletRepository";
import { IndexedDBContractRepository } from "../src/repositories/indexedDB/contractRepository";
import { IndexedDBStorageAdapter } from "../src/storage/indexedDB";
import { InMemoryStorageAdapter } from "../src/storage/inMemory";
import type {
    ExtendedVirtualCoin,
    ExtendedCoin,
    ArkTransaction,
    TxType,
} from "../src/wallet";
import type { TapLeafScript } from "../src/script/base";

type RepositoryTestItem<T> = {
    name: string;
    factory: () => Promise<T>;
};

const walletRepositoryImplementations: Array<
    RepositoryTestItem<WalletRepository>
> = [
    {
        name: "WalletRepositoryImpl (InMemoryStorage)",
        factory: async () => {
            const storage = new InMemoryStorageAdapter();
            return new WalletRepositoryImpl(storage);
        },
    },
    {
        name: "WalletRepositoryImpl (IndexedDBStorage)",
        factory: async () => {
            const dbName = getUniqueDbName("wallet-repo");
            const storage = new IndexedDBStorageAdapter(dbName, 1);
            return new WalletRepositoryImpl(storage);
        },
    },
    {
        name: "IndexedDBWalletRepository",
        factory: async () => {
            const dbName = getUniqueDbName("wallet-idb");
            return await IndexedDBWalletRepository.create(dbName);
        },
    },
];

const contractRepositoryImplementations: Array<
    RepositoryTestItem<ContractRepository>
> = [
    {
        name: "ContractRepositoryImpl (InMemoryStorage)",
        factory: async () => {
            const storage = new InMemoryStorageAdapter();
            return new ContractRepositoryImpl(storage);
        },
    },
    {
        name: "ContractRepositoryImpl (IndexedDBStorage)",
        factory: async () => {
            const dbName = getUniqueDbName("contract-repo");
            const storage = new IndexedDBStorageAdapter(dbName, 1);
            return new ContractRepositoryImpl(storage);
        },
    },
    {
        name: "IndexedDBContractRepository",
        factory: async () => {
            const dbName = getUniqueDbName("contract-idb");
            return await IndexedDBContractRepository.create(dbName);
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

            it("should remove a specific VTXO", async () => {
                const vtxo1 = createMockVtxo("tx1", 0, 10000);
                const vtxo2 = createMockVtxo("tx2", 1, 20000);
                await repository.saveVtxos(testAddress, [vtxo1, vtxo2]);

                await repository.removeVtxo(testAddress, "tx1:0");
                const retrieved = await repository.getVtxos(testAddress);

                expect(retrieved).toHaveLength(1);
                expect(retrieved[0].txid).toBe("tx2");
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

            it("should remove a specific UTXO", async () => {
                const utxo1 = createMockUtxo("tx1", 0, 10000);
                const utxo2 = createMockUtxo("tx2", 1, 20000);
                await repository.saveUtxos(testAddress, [utxo1, utxo2]);

                await repository.removeUtxo(testAddress, "tx1:0");
                const retrieved = await repository.getUtxos(testAddress);

                expect(retrieved).toHaveLength(1);
                expect(retrieved[0].txid).toBe("tx2");
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
    it("should migrate from version 1 to version 2", async () => {
        const dbName = getUniqueDbName("wallet-idb");

        const storage = new IndexedDBStorageAdapter(dbName, 1);
        const walletRepoV1 = new WalletRepositoryImpl(storage);
        const contractRepoV1 = new ContractRepositoryImpl(storage);

        const testAddress = "test-address-123";
        const testContractId = "test-contract-123";
        const testKey = "test-key";

        const vtxo1 = createMockVtxo("txvtxo1", 0, 10000);
        const vtxo2 = createMockVtxo("txvtxo2", 1, 20000);
        const utxo1 = createMockUtxo("txutxo1", 0, 10000);
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
        const walletState = {
            lastSyncTime: Date.now(),
            settings: { theme: "dark" },
        };
        const contractData = {
            status: "active",
            amount: 1000,
        };

        // store some data in the v1 database
        await walletRepoV1.saveVtxos(testAddress, [vtxo1, vtxo2]);
        await walletRepoV1.saveUtxos(testAddress, [utxo1]);
        await walletRepoV1.saveTransactions(testAddress, [tx1, tx2]);
        await walletRepoV1.saveWalletState(walletState);

        await contractRepoV1.setContractData(
            testContractId,
            testKey,
            contractData
        );
        await contractRepoV1.saveToContractCollection(
            "swaps",
            { id: "1" },
            "id"
        );

        // close the v1 database
        storage["db"]?.close();

        // open the v2 database
        const walletRepoV2 = await IndexedDBWalletRepository.create(dbName);
        const contractRepoV2 = await IndexedDBContractRepository.create(dbName);

        const vtxos = await walletRepoV2.getVtxos(testAddress);
        expect(vtxos).toHaveLength(2);
        expect(vtxos[0].txid).toBe("txvtxo1");
        expect(vtxos[1].txid).toBe("txvtxo2");

        const utxos = await walletRepoV2.getUtxos(testAddress);
        expect(utxos).toHaveLength(1);
        expect(utxos[0].txid).toBe("txutxo1");

        const txs = await walletRepoV2.getTransactionHistory(testAddress);
        expect(txs).toHaveLength(2);
        expect(txs[0].key.boardingTxid).toBe("btx1");
        expect(txs[0].type).toBe("SENT");
        expect(txs[1].key.commitmentTxid).toBe("ctx2");
        expect(txs[1].type).toBe("RECEIVED");

        const walletState2 = await walletRepoV2.getWalletState();
        expect(walletState2?.settings?.theme).toBe("dark");
        const contractData2 = await contractRepoV2.getContractData(
            testContractId,
            testKey
        );
        expect(contractData2).toEqual(contractData);
        const collection2 = await contractRepoV2.getContractCollection<{
            id: string;
        }>("swaps");
        expect(collection2).toHaveLength(1);
        expect(collection2[0].id).toBe("1");
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
