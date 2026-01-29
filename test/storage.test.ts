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
import { migrateWalletRepository } from "../src/repositories/migrations/fromStorageAdapter";
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
        await walletRepoV1.saveUtxos(testAddress1, [utxo1]);
        await walletRepoV1.saveUtxos(testAddress2, [utxo2]);
        await walletRepoV1.saveTransactions(testAddress1, [tx1, tx2]);
        await walletRepoV1.saveTransactions(testAddress2, [tx3]);
        await walletRepoV1.saveWalletState(walletState);

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
