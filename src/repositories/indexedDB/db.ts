import { hex } from "@scure/base";
import { TapLeafScript } from "../../script/base";
import {
    ArkTransaction,
    ExtendedCoin,
    ExtendedVirtualCoin,
} from "../../wallet";
import { TaprootControlBlock } from "@scure/btc-signer";
import { WalletState } from "../walletRepository";
import { DEFAULT_DB_NAME } from "../../wallet/serviceWorker/utils";

// Store names
export const STORE_VTXOS = "vtxos";
export const STORE_UTXOS = "utxos";
export const STORE_TRANSACTIONS = "transactions";
export const STORE_WALLET_STATE = "walletState";
export const STORE_CONTRACT_DATA = "contractData";
export const STORE_COLLECTIONS = "collections";
export const DB_VERSION = 2;

// Serialization helpers
export const toHex = (b: Uint8Array | undefined) =>
    b ? hex.encode(b) : undefined;
export const fromHex = (h: string | undefined) =>
    h ? hex.decode(h) : (undefined as any);

export const serializeTapLeaf = ([cb, s]: TapLeafScript) => ({
    cb: hex.encode(TaprootControlBlock.encode(cb)),
    s: hex.encode(s),
});

export const serializeVtxo = (v: ExtendedVirtualCoin) => ({
    ...v,
    tapTree: toHex(v.tapTree),
    forfeitTapLeafScript: serializeTapLeaf(v.forfeitTapLeafScript),
    intentTapLeafScript: serializeTapLeaf(v.intentTapLeafScript),
    extraWitness: v.extraWitness?.map(toHex),
});

export const serializeUtxo = (u: ExtendedCoin) => ({
    ...u,
    tapTree: toHex(u.tapTree),
    forfeitTapLeafScript: serializeTapLeaf(u.forfeitTapLeafScript),
    intentTapLeafScript: serializeTapLeaf(u.intentTapLeafScript),
    extraWitness: u.extraWitness?.map(toHex),
});

export const deserializeTapLeaf = (t: {
    cb: string;
    s: string;
}): TapLeafScript => {
    const cb = TaprootControlBlock.decode(fromHex(t.cb));
    const s = fromHex(t.s);
    return [cb, s];
};

export const deserializeVtxo = (o: any): ExtendedVirtualCoin => ({
    ...o,
    createdAt: new Date(o.createdAt),
    tapTree: fromHex(o.tapTree),
    forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
    intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
    extraWitness: o.extraWitness?.map(fromHex),
});

export const deserializeUtxo = (o: any): ExtendedCoin => ({
    ...o,
    tapTree: fromHex(o.tapTree),
    forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
    intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
    extraWitness: o.extraWitness?.map(fromHex),
});

// database instance cache, avoiding multiple open requests
const dbCache = new Map<string, IDBDatabase>();

/**
 * Opens an IndexedDB database with shared upgrade handling for both wallet and contract repositories.
 */
export async function openDatabase(
    dbName: string = DEFAULT_DB_NAME,
    withMigration = false
): Promise<IDBDatabase> {
    // Return cached instance if available
    if (dbCache.has(dbName)) {
        const cached = dbCache.get(dbName)!;
        if (!cached.version) {
            // Database was closed, remove from cache
            dbCache.delete(dbName);
        } else {
            return cached;
        }
    }

    const globalObject = typeof window === "undefined" ? self : window;

    if (!(globalObject && "indexedDB" in globalObject)) {
        throw new Error("IndexedDB is not available in this environment");
    }

    return new Promise((resolve, reject) => {
        const request = globalObject.indexedDB.open(dbName, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            dbCache.set(dbName, db);
            resolve(db);
        };

        request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
            if (withMigration) {
                handleUpgrade(event);
            }
        };
    });
}

/**
 * Handles the upgrade of the database schema.
 * It supports migration from v1 (repositories/walletRepository.ts) to v2 (repositories/indexedDB/walletRepository.ts).
 * @param event - The event object containing the old version and the new version.
 */
function handleUpgrade(event: IDBVersionChangeEvent): void {
    const db = (event.target as IDBOpenDBRequest).result;
    const oldVersion = event.oldVersion;
    const transaction = (event.target as IDBOpenDBRequest).transaction;

    if (!transaction) {
        console.error("Transaction not available during upgrade");
        return;
    }

    // Add error handler to transaction to prevent silent aborts
    transaction.onerror = (event) => {
        console.error("Transaction error during upgrade:", event);
    };

    transaction.onabort = (event) => {
        console.error("Transaction aborted during upgrade:", event);
    };

    // Create wallet repository stores
    let vtxosStore: IDBObjectStore;
    let utxosStore: IDBObjectStore;
    let transactionsStore: IDBObjectStore;
    let walletStateStore: IDBObjectStore;

    // Create contract repository stores
    let contractDataStore: IDBObjectStore;
    let collectionsStore: IDBObjectStore;

    try {
        // Create wallet stores
        if (!db.objectStoreNames.contains(STORE_VTXOS)) {
            db.createObjectStore(STORE_VTXOS, {
                keyPath: ["address", "txid", "vout"],
            });
        }
        vtxosStore = transaction.objectStore(STORE_VTXOS);

        if (!vtxosStore.indexNames.contains("address")) {
            vtxosStore.createIndex("address", "address", {
                unique: false,
            });
        }
        if (!vtxosStore.indexNames.contains("txid")) {
            vtxosStore.createIndex("txid", "txid", { unique: false });
        }
        if (!vtxosStore.indexNames.contains("value")) {
            vtxosStore.createIndex("value", "value", { unique: false });
        }
        if (!vtxosStore.indexNames.contains("status")) {
            vtxosStore.createIndex("status", "status", {
                unique: false,
            });
        }
        if (!vtxosStore.indexNames.contains("virtualStatus")) {
            vtxosStore.createIndex("virtualStatus", "virtualStatus", {
                unique: false,
            });
        }
        if (!vtxosStore.indexNames.contains("createdAt")) {
            vtxosStore.createIndex("createdAt", "createdAt", {
                unique: false,
            });
        }
        if (!vtxosStore.indexNames.contains("isSpent")) {
            vtxosStore.createIndex("isSpent", "isSpent", {
                unique: false,
            });
        }
        if (!vtxosStore.indexNames.contains("isUnrolled")) {
            vtxosStore.createIndex("isUnrolled", "isUnrolled", {
                unique: false,
            });
        }
        if (!vtxosStore.indexNames.contains("spentBy")) {
            vtxosStore.createIndex("spentBy", "spentBy", {
                unique: false,
            });
        }
        if (!vtxosStore.indexNames.contains("settledBy")) {
            vtxosStore.createIndex("settledBy", "settledBy", {
                unique: false,
            });
        }
        if (!vtxosStore.indexNames.contains("arkTxId")) {
            vtxosStore.createIndex("arkTxId", "arkTxId", {
                unique: false,
            });
        }

        if (!db.objectStoreNames.contains(STORE_UTXOS)) {
            db.createObjectStore(STORE_UTXOS, {
                keyPath: ["address", "txid", "vout"],
            });
        }
        utxosStore = transaction.objectStore(STORE_UTXOS);

        if (!utxosStore.indexNames.contains("address")) {
            utxosStore.createIndex("address", "address", {
                unique: false,
            });
        }
        if (!utxosStore.indexNames.contains("txid")) {
            utxosStore.createIndex("txid", "txid", { unique: false });
        }
        if (!utxosStore.indexNames.contains("value")) {
            utxosStore.createIndex("value", "value", { unique: false });
        }
        if (!utxosStore.indexNames.contains("status")) {
            utxosStore.createIndex("status", "status", {
                unique: false,
            });
        }

        if (!db.objectStoreNames.contains(STORE_TRANSACTIONS)) {
            db.createObjectStore(STORE_TRANSACTIONS, {
                keyPath: [
                    "address",
                    "keyBoardingTxid",
                    "keyCommitmentTxid",
                    "keyArkTxid",
                ],
            });
        }
        transactionsStore = transaction.objectStore(STORE_TRANSACTIONS);

        if (!transactionsStore.indexNames.contains("address")) {
            transactionsStore.createIndex("address", "address", {
                unique: false,
            });
        }
        if (!transactionsStore.indexNames.contains("type")) {
            transactionsStore.createIndex("type", "type", {
                unique: false,
            });
        }
        if (!transactionsStore.indexNames.contains("amount")) {
            transactionsStore.createIndex("amount", "amount", {
                unique: false,
            });
        }
        if (!transactionsStore.indexNames.contains("settled")) {
            transactionsStore.createIndex("settled", "settled", {
                unique: false,
            });
        }
        if (!transactionsStore.indexNames.contains("createdAt")) {
            transactionsStore.createIndex("createdAt", "createdAt", {
                unique: false,
            });
        }
        if (!transactionsStore.indexNames.contains("arkTxid")) {
            transactionsStore.createIndex("arkTxid", "key.arkTxid", {
                unique: false,
            });
        }

        if (!db.objectStoreNames.contains(STORE_WALLET_STATE)) {
            db.createObjectStore(STORE_WALLET_STATE, {
                keyPath: "key",
            });
        }
        walletStateStore = transaction.objectStore(STORE_WALLET_STATE);

        // Create contract stores
        if (!db.objectStoreNames.contains(STORE_CONTRACT_DATA)) {
            db.createObjectStore(STORE_CONTRACT_DATA, {
                keyPath: ["contractId", "key"],
            });
        }
        contractDataStore = transaction.objectStore(STORE_CONTRACT_DATA);

        if (!contractDataStore.indexNames.contains("contractId")) {
            contractDataStore.createIndex("contractId", "contractId", {
                unique: false,
            });
        }

        if (!db.objectStoreNames.contains(STORE_COLLECTIONS)) {
            db.createObjectStore(STORE_COLLECTIONS, {
                keyPath: "contractType",
            });
        }
        collectionsStore = transaction.objectStore(STORE_COLLECTIONS);
    } catch (error) {
        console.error("Error during upgrade setup:", error);
    }

    // Migrate data from old "storage" object store if upgrading from version 1
    if (oldVersion === 1 && db.objectStoreNames.contains("storage")) {
        try {
            const oldStorageStore = transaction.objectStore("storage");
            const cursorRequest = oldStorageStore.openCursor();

            cursorRequest.onsuccess = (cursorEvent: Event) => {
                const cursor = (
                    cursorEvent.target as IDBRequest<IDBCursorWithValue>
                ).result;
                if (!cursor) {
                    return; // Migration complete
                }

                const key = cursor.key as string;
                const value = cursor.value as string;

                try {
                    // Migrate VTXOs: vtxos:${address}
                    if (key.startsWith("vtxos:")) {
                        const address = key.substring(6); // Remove "vtxos:" prefix
                        const vtxos = JSON.parse(value) as any[];
                        for (const vtxo of vtxos) {
                            const deserialized = deserializeVtxo(vtxo);
                            const serialized = serializeVtxo(deserialized);
                            vtxosStore.put({
                                address,
                                ...serialized,
                            });
                        }
                    }
                    // Migrate UTXOs: utxos:${address}
                    else if (key.startsWith("utxos:")) {
                        const address = key.substring(6); // Remove "utxos:" prefix
                        const utxos = JSON.parse(value) as any[];
                        for (const utxo of utxos) {
                            const deserialized = deserializeUtxo(utxo);
                            const serialized = serializeUtxo(deserialized);
                            utxosStore.put({
                                address,
                                ...serialized,
                            });
                        }
                    }
                    // Migrate Transactions: tx:${address}
                    else if (key.startsWith("tx:")) {
                        const address = key.substring(3); // Remove "tx:" prefix
                        const txs = JSON.parse(value) as ArkTransaction[];
                        for (const tx of txs) {
                            transactionsStore.put({
                                address,
                                ...tx,
                                keyBoardingTxid: tx.key.boardingTxid,
                                keyCommitmentTxid: tx.key.commitmentTxid,
                                keyArkTxid: tx.key.arkTxid,
                            });
                        }
                    }
                    // Migrate Wallet State: wallet:state
                    else if (key === "wallet:state") {
                        const state = JSON.parse(value) as WalletState;
                        walletStateStore.put({
                            key: "state",
                            data: state,
                        });
                    }
                    // Migrate contract data: contract:${contractId}:${key}
                    else if (key.startsWith("contract:")) {
                        const parts = key.substring(9).split(":"); // Remove "contract:" prefix
                        if (parts.length >= 2) {
                            const contractId = parts[0];
                            const dataKey = parts.slice(1).join(":"); // Handle keys with colons
                            const data = JSON.parse(value);
                            contractDataStore.put({
                                contractId,
                                key: dataKey,
                                data,
                            });
                        }
                    }
                    // Migrate collections: collection:${contractType}
                    else if (key.startsWith("collection:")) {
                        const contractType = key.substring(11); // Remove "collection:" prefix
                        const items = JSON.parse(value);
                        collectionsStore.put({
                            contractType,
                            items,
                        });
                    }
                } catch (error) {
                    console.error(
                        `Failed to migrate data for key ${key}:`,
                        error
                    );
                }

                cursor.continue();
            };

            cursorRequest.onerror = () => {
                console.error(
                    "Failed to read old storage data for migration:",
                    cursorRequest.error
                );
            };
        } catch (error) {
            console.error("Failed to start migration:", error);
        }
    }
}
