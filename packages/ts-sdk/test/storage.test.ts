import { describe, it, expect, beforeEach, vi } from "vitest";
import { hex } from "@scure/base";
import { TaprootControlBlock } from "@scure/btc-signer";
import { IndexedDBWalletRepository } from "../src/repositories/indexedDB/walletRepository";
import {
    migrateWalletRepository,
    getMigrationStatus,
    requiresMigration,
    rollbackMigration,
    MIGRATION_KEY,
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

export type RepositoryTestItem<T> = {
    name: string;
    factory: () => Promise<T>;
};

describe("IndexedDB migrations", () => {
    it("should migrate wallet data from StorageAdapter to IndexedDB format", async () => {
        const oldDbName = getUniqueDbName("wallet-migration-old");
        const newDbName = getUniqueDbName("wallet-migration-new");

        const oldStorage = new IndexedDBStorageAdapter(oldDbName, 1);
        const walletRepoV1 = new WalletRepositoryImpl(oldStorage);

        const testAddress1 = "test-address-1";
        const testAddress2 = "test-address-2";
        const testAddress3 = "test-address-3";

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

        await walletRepoV1.saveVtxos(testAddress1, [vtxo1, vtxo2]);
        await walletRepoV1.saveVtxos(testAddress2, [vtxo3]);
        await walletRepoV1.saveUtxos(testAddress3, [utxo1]);
        await walletRepoV1.saveUtxos(testAddress3, [utxo2]);
        await walletRepoV1.saveTransactions(testAddress1, [tx1, tx2]);
        await walletRepoV1.saveTransactions(testAddress2, [tx3]);
        await walletRepoV1.saveWalletState(walletState);

        const walletRepoV2 = new IndexedDBWalletRepository(newDbName);

        await migrateWalletRepository(oldStorage, walletRepoV2, {
            offchain: [testAddress1, testAddress2],
            onchain: [testAddress3],
        });

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

        const utxos1 = await walletRepoV2.getUtxos(testAddress3);
        expect(utxos1).toHaveLength(2);
        expect(utxos1[0].txid).toBe("txutxo1");
        expect(utxos1[0].value).toBe(10000);

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

        await migrateWalletRepository(oldStorage, walletRepoV2, {
            onchain: [testAddress],
            offchain: [],
        });

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
                throw new DOMException(
                    "One of the specified object stores was not found",
                    "NotFoundError"
                );
            },
        } as any;
        const testAddress = "test-address";

        const walletRepoV2 = {
            getVtxos: vi.fn(),
            saveVtxos: vi.fn(),
        } as any;

        await migrateWalletRepository(oldStorage, walletRepoV2, {
            onchain: [testAddress],
            offchain: [],
        });
        expect(walletRepoV2.getVtxos).not.toHaveBeenCalled();
        expect(walletRepoV2.saveVtxos).not.toHaveBeenCalled();
    });
});

describe("getMigrationStatus", () => {
    it("should return 'not-needed' when legacy DB doesn't exist", async () => {
        const oldStorage = {
            getItem: () => {
                throw new DOMException(
                    "One of the specified object stores was not found",
                    "NotFoundError"
                );
            },
        } as any;

        const status = await getMigrationStatus("wallet", oldStorage);
        expect(status).toBe("not-needed");
    });

    it("should return 'pending' on fresh legacy DB", async () => {
        const oldDbName = getUniqueDbName("status-pending");
        const oldStorage = new IndexedDBStorageAdapter(oldDbName, 1);
        // Initialize the DB by writing something so the object store exists
        const walletRepo = new WalletRepositoryImpl(oldStorage);
        await walletRepo.saveWalletState({ lastSyncTime: Date.now() });

        const status = await getMigrationStatus("wallet", oldStorage);
        expect(status).toBe("pending");
    });

    it("should return 'done' after successful migration", async () => {
        const oldDbName = getUniqueDbName("status-done-old");
        const newDbName = getUniqueDbName("status-done-new");

        const oldStorage = new IndexedDBStorageAdapter(oldDbName, 1);
        const walletRepo = new WalletRepositoryImpl(oldStorage);
        await walletRepo.saveWalletState({ lastSyncTime: Date.now() });

        const fresh = new IndexedDBWalletRepository(newDbName);
        await migrateWalletRepository(oldStorage, fresh, {
            onchain: [],
            offchain: [],
        });

        const status = await getMigrationStatus("wallet", oldStorage);
        expect(status).toBe("done");
    });

    it("should return 'in-progress' when migration was interrupted", async () => {
        const oldDbName = getUniqueDbName("status-in-progress");
        const oldStorage = new IndexedDBStorageAdapter(oldDbName, 1);
        // Initialize the DB
        const walletRepo = new WalletRepositoryImpl(oldStorage);
        await walletRepo.saveWalletState({ lastSyncTime: Date.now() });

        // Simulate interrupted migration by setting flag manually
        await oldStorage.setItem(MIGRATION_KEY("wallet"), "in-progress");

        const status = await getMigrationStatus("wallet", oldStorage);
        expect(status).toBe("in-progress");
    });
});

describe("requiresMigration", () => {
    it("should return true for 'pending' status", async () => {
        const oldDbName = getUniqueDbName("requires-pending");
        const oldStorage = new IndexedDBStorageAdapter(oldDbName, 1);
        const walletRepo = new WalletRepositoryImpl(oldStorage);
        await walletRepo.saveWalletState({ lastSyncTime: Date.now() });

        const result = await requiresMigration("wallet", oldStorage);
        expect(result).toBe(true);
    });

    it("should return true for 'in-progress' status", async () => {
        const oldDbName = getUniqueDbName("requires-in-progress");
        const oldStorage = new IndexedDBStorageAdapter(oldDbName, 1);
        const walletRepo = new WalletRepositoryImpl(oldStorage);
        await walletRepo.saveWalletState({ lastSyncTime: Date.now() });
        await oldStorage.setItem(MIGRATION_KEY("wallet"), "in-progress");

        const result = await requiresMigration("wallet", oldStorage);
        expect(result).toBe(true);
    });

    it("should return false for 'done' status", async () => {
        const oldDbName = getUniqueDbName("requires-done");
        const oldStorage = new IndexedDBStorageAdapter(oldDbName, 1);
        const walletRepo = new WalletRepositoryImpl(oldStorage);
        await walletRepo.saveWalletState({ lastSyncTime: Date.now() });
        await oldStorage.setItem(MIGRATION_KEY("wallet"), "done");

        const result = await requiresMigration("wallet", oldStorage);
        expect(result).toBe(false);
    });

    it("should return false for 'not-needed' status", async () => {
        const oldStorage = {
            getItem: () => {
                throw new DOMException(
                    "One of the specified object stores was not found",
                    "NotFoundError"
                );
            },
        } as any;

        const result = await requiresMigration("wallet", oldStorage);
        expect(result).toBe(false);
    });
});

describe("rollbackMigration", () => {
    it("should reset the flag so migration re-runs", async () => {
        const oldDbName = getUniqueDbName("rollback");
        const newDbName = getUniqueDbName("rollback-new");
        const oldStorage = new IndexedDBStorageAdapter(oldDbName, 1);
        const walletRepo = new WalletRepositoryImpl(oldStorage);
        const testAddress = "test-address";

        const vtxo = createMockVtxo("txrollback", 0, 5000);
        await walletRepo.saveVtxos(testAddress, [vtxo]);

        // First migration
        const fresh = new IndexedDBWalletRepository(newDbName);
        await migrateWalletRepository(oldStorage, fresh, {
            onchain: [],
            offchain: [testAddress],
        });

        const statusAfterMigration = await getMigrationStatus(
            "wallet",
            oldStorage
        );
        expect(statusAfterMigration).toBe("done");

        // Rollback
        await rollbackMigration("wallet", oldStorage);

        const statusAfterRollback = await getMigrationStatus(
            "wallet",
            oldStorage
        );
        expect(statusAfterRollback).toBe("pending");

        // Migration should re-run
        const needsMigration = await requiresMigration("wallet", oldStorage);
        expect(needsMigration).toBe(true);
    });
});

describe("migrateWalletRepository in-progress flag", () => {
    it("should set 'in-progress' before copying data", async () => {
        const callOrder: string[] = [];

        const mockStorage = {
            getItem: vi.fn().mockImplementation(async () => {
                // No migration flag set yet → pending
                return null;
            }),
            setItem: vi
                .fn()
                .mockImplementation(async (key: string, value: string) => {
                    callOrder.push(`setItem:${value}`);
                }),
            removeItem: vi.fn(),
        } as any;

        const mockOldRepo = {
            getWalletState: vi.fn().mockImplementation(async () => {
                callOrder.push("getWalletState");
                return null;
            }),
            getVtxos: vi.fn().mockResolvedValue([]),
            getUtxos: vi.fn().mockResolvedValue([]),
            getTransactionHistory: vi.fn().mockResolvedValue([]),
        };

        // Patch the WalletRepositoryImpl constructor to return our mock
        const origImpl = WalletRepositoryImpl;
        vi.spyOn(
            await import("../src/repositories/migrations/walletRepositoryImpl"),
            "WalletRepositoryImpl"
        ).mockImplementation(() => mockOldRepo as any);

        const mockFresh = {
            saveWalletState: vi.fn(),
            saveVtxos: vi.fn(),
            saveUtxos: vi.fn(),
            saveTransactions: vi.fn(),
        } as any;

        await migrateWalletRepository(mockStorage, mockFresh, {
            onchain: [],
            offchain: [],
        });

        // Verify "in-progress" was set before data reads
        expect(callOrder[0]).toBe("setItem:in-progress");
        // Verify "done" was set at the end
        expect(callOrder[callOrder.length - 1]).toBe("setItem:done");

        vi.restoreAllMocks();
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

export function createMockVtxo(
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

export function createMockUtxo(
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
export function createMockTransaction(
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
