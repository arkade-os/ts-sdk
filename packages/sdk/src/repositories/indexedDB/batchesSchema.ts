// Experimental intent and virtual-tx persistence. Its own database, apart from
// the wallet's (`schema.ts`): these stores evolve without upgrading the wallet
// schema, and only the opt-in repositories ever open it.
export const BATCHES_DB_NAME = "arkade-batches";
export const BATCHES_DB_VERSION = 1;

export const STORE_INTENTS = "intents";
export const STORE_VIRTUAL_TXS = "virtualTxs";
export const STORE_VTXO_BRANCHES = "vtxoBranches";

export function initBatchesDatabase(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(STORE_INTENTS)) {
        const intentsStore = db.createObjectStore(STORE_INTENTS, {
            keyPath: "intentTxId",
        });
        // Unique-when-present: records with no intentId aren't indexed, so many
        // pre-registration intents coexist; a duplicate intentId is rejected.
        intentsStore.createIndex("intentId", "intentId", { unique: true });
        intentsStore.createIndex("state", "state", { unique: false });
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
