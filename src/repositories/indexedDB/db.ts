import { hex } from "@scure/base";
import { TapLeafScript } from "../../script/base";
import { ExtendedCoin, ExtendedVirtualCoin } from "../../wallet";
import { TaprootControlBlock } from "@scure/btc-signer";
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

export type SerializedVtxo = ReturnType<typeof serializeVtxo>;
export type SerializedUtxo = ReturnType<typeof serializeUtxo>;

export const serializeTapLeaf = ([cb, s]: TapLeafScript) => ({
    cb: hex.encode(TaprootControlBlock.encode(cb)),
    s: hex.encode(s),
});

export const serializeVtxo = (v: ExtendedVirtualCoin) => ({
    ...v,
    tapTree: hex.encode(v.tapTree),
    forfeitTapLeafScript: serializeTapLeaf(v.forfeitTapLeafScript),
    intentTapLeafScript: serializeTapLeaf(v.intentTapLeafScript),
    extraWitness: v.extraWitness?.map(hex.encode),
});

export const serializeUtxo = (u: ExtendedCoin) => ({
    ...u,
    tapTree: hex.encode(u.tapTree),
    forfeitTapLeafScript: serializeTapLeaf(u.forfeitTapLeafScript),
    intentTapLeafScript: serializeTapLeaf(u.intentTapLeafScript),
    extraWitness: u.extraWitness?.map(hex.encode),
});

export const deserializeTapLeaf = (t: {
    cb: string;
    s: string;
}): TapLeafScript => {
    const cb = TaprootControlBlock.decode(hex.decode(t.cb));
    const s = hex.decode(t.s);
    return [cb, s];
};

export const deserializeVtxo = (o: SerializedVtxo): ExtendedVirtualCoin => ({
    ...o,
    createdAt: new Date(o.createdAt),
    tapTree: hex.decode(o.tapTree),
    forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
    intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
    extraWitness: o.extraWitness?.map(hex.decode),
});

export const deserializeUtxo = (o: SerializedUtxo): ExtendedCoin => ({
    ...o,
    tapTree: hex.decode(o.tapTree),
    forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
    intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
    extraWitness: o.extraWitness?.map(hex.decode),
});

// database instance cache, avoiding multiple open requests
const dbCache = new Map<string, IDBDatabase>();

/**
 * Opens an IndexedDB database.
 */
export async function openDatabase(
    dbName: string = DEFAULT_DB_NAME
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

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = globalObject.indexedDB.open(dbName, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            dbCache.set(dbName, db);
            resolve(db);
        };
        request.onupgradeneeded = () => {
            const db = request.result;
            initDatabase(db);
        };
    });

    return db;
}

function initDatabase(db: IDBDatabase): IDBDatabase {
    // Create wallet stores
    if (!db.objectStoreNames.contains(STORE_VTXOS)) {
        const vtxosStore = db.createObjectStore(STORE_VTXOS, {
            keyPath: ["address", "txid", "vout"],
        });

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
    }

    if (!db.objectStoreNames.contains(STORE_UTXOS)) {
        const utxosStore = db.createObjectStore(STORE_UTXOS, {
            keyPath: ["address", "txid", "vout"],
        });

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
    }

    if (!db.objectStoreNames.contains(STORE_TRANSACTIONS)) {
        const transactionsStore = db.createObjectStore(STORE_TRANSACTIONS, {
            keyPath: [
                "address",
                "keyBoardingTxid",
                "keyCommitmentTxid",
                "keyArkTxid",
            ],
        });

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
    }

    if (!db.objectStoreNames.contains(STORE_WALLET_STATE)) {
        db.createObjectStore(STORE_WALLET_STATE, {
            keyPath: "key",
        });
    }

    // Create contract stores
    if (!db.objectStoreNames.contains(STORE_CONTRACT_DATA)) {
        const contractDataStore = db.createObjectStore(STORE_CONTRACT_DATA, {
            keyPath: ["contractId", "key"],
        });

        if (!contractDataStore.indexNames.contains("contractId")) {
            contractDataStore.createIndex("contractId", "contractId", {
                unique: false,
            });
        }
    }

    if (!db.objectStoreNames.contains(STORE_COLLECTIONS)) {
        db.createObjectStore(STORE_COLLECTIONS, {
            keyPath: "contractType",
        });
    }
    return db;
}
