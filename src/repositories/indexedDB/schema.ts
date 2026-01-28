// Store names introduced in V2, they are all new to the migration
export const STORE_VTXOS = "vtxos";
export const STORE_UTXOS = "utxos";
export const STORE_TRANSACTIONS = "transactions";
export const STORE_WALLET_STATE = "walletState";
export const STORE_COMMITMENT_TXS = "commitmentTxs";
export const STORE_CONTRACTS = "contracts";

// @deprecated use only for migrations, this is created in V1
export const LEGACY_STORE_CONTRACT_COLLECTIONS = "contractsCollections";

export const DB_VERSION = 2;

export function initDatabase(db: IDBDatabase): IDBDatabase {
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

    if (!db.objectStoreNames.contains(STORE_COMMITMENT_TXS)) {
        db.createObjectStore(STORE_COMMITMENT_TXS, { keyPath: "txid" });
    }

    // Create contract stores
    if (!db.objectStoreNames.contains(STORE_CONTRACTS)) {
        const contractsStore = db.createObjectStore(STORE_CONTRACTS, {
            keyPath: "id",
        });

        if (!contractsStore.indexNames.contains("type")) {
            contractsStore.createIndex("type", "type", {
                unique: false,
            });
        }
        if (!contractsStore.indexNames.contains("state")) {
            contractsStore.createIndex("state", "state", {
                unique: false,
            });
        }
        if (!contractsStore.indexNames.contains("script")) {
            contractsStore.createIndex("script", "script", {
                unique: true,
            });
        }
    }

    if (!db.objectStoreNames.contains(LEGACY_STORE_CONTRACT_COLLECTIONS)) {
        db.createObjectStore(LEGACY_STORE_CONTRACT_COLLECTIONS, {
            keyPath: "key",
        });
    }
    return db;
}
