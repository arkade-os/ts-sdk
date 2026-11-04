// Experimental batch registration and virtual-tx persistence. Its own database, apart from
// the wallet's (`schema.ts`): these stores evolve without upgrading the wallet
// schema, and only the opt-in repositories ever open it.
export const BATCHES_DB_NAME = "arkade-batches";
export const BATCHES_DB_VERSION = 1;

// PERSISTED: this store name, its keyPath and its index names keep their pre-rename
// spelling. Changing them orphans every record on disk.
export const STORE_BATCH_REGISTRATIONS = "intents";
export const STORE_VIRTUAL_TXS = "virtualTxs";
export const STORE_VTXO_BRANCHES = "vtxoBranches";

export function initBatchesDatabase(
    db: IDBDatabase,
    _oldVersion: number,
    _transaction: IDBTransaction | null,
): void {
    if (!db.objectStoreNames.contains(STORE_BATCH_REGISTRATIONS)) {
        const registrationsStore = db.createObjectStore(STORE_BATCH_REGISTRATIONS, {
            keyPath: "intentTxId",
        });
        // Unique-when-present: records with no intentId aren't indexed, so many
        // unregistered records coexist; a duplicate intentId is rejected.
        registrationsStore.createIndex("intentId", "intentId", { unique: true });
        registrationsStore.createIndex("state", "state", { unique: false });
    }
    if (!db.objectStoreNames.contains(STORE_VIRTUAL_TXS)) {
        db.createObjectStore(STORE_VIRTUAL_TXS, { keyPath: "txid" });
    }
    if (!db.objectStoreNames.contains(STORE_VTXO_BRANCHES)) {
        const branchesStore = db.createObjectStore(STORE_VTXO_BRANCHES, {
            keyPath: ["vtxoTxid", "vtxoVout", "position"],
        });
        branchesStore.createIndex("vtxo", ["vtxoTxid", "vtxoVout"], { unique: false });
        branchesStore.createIndex("virtualTxid", "virtualTxid", { unique: false });
    }
}
