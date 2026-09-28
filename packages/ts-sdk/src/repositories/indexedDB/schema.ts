import { scriptFromArkAddress } from "../scriptFromAddress";
import { unspentIndexFlagForVtxo } from "../serialization";

// Store names introduced in V2, they are all new to the migration
export const STORE_VTXOS = "vtxos";
export const STORE_UTXOS = "utxos";
export const STORE_TRANSACTIONS = "transactions";
export const STORE_WALLET_STATE = "walletState";
export const STORE_CONTRACTS = "contracts";
export const STORE_INTENTS = "intents";
export const STORE_VIRTUAL_TXS = "virtualTxs";
export const STORE_VTXO_BRANCHES = "vtxoBranches";

// @deprecated use only for migrations, this is created in V1
export const LEGACY_STORE_CONTRACT_COLLECTIONS = "contractsCollections";

// Version history:
//   v1 — initial wallet repo schema, `contractsCollections` store.
//   v2 — new `vtxos/utxos/transactions/walletState/contracts` stores.
//   v3 — add `script` index on the vtxos store and backfill missing
//        `vtxo.script` from `vtxo.address` so the field is always present
//        at read time. Matches the `script` indexing already in place for
//        Realm (`realm/schemas.ts`) and SQLite (`sqlite/walletRepository.ts`).
//   v4 — add intent + virtualtx persistence: `intents`, `virtualTxs`,
//        `vtxoBranches` object stores (new, empty — no backfill).
//   v5 — make `intents.intentId` unique (was non-unique in v4), matching the
//        "unique when present" contract enforced by the other backends.
//   v6 — index (script, unspent) for each unspent VTXO. Existing rows are
//        backfilled in the upgrade transaction; spent history stays stored.
// A database opened at v6 cannot be reopened by an older SDK requesting v3.
// Consumers must coordinate the SDK upgrade across tabs.
export const DB_VERSION = 6;

// Intent/virtualtx persistence is still opt-in: these stores are created only
// by initDatabaseWithIntents on a dedicated DB name, never by initDatabase on
// the shared wallet path. Both paths now open at v6 for the active VTXO index.
export const INTENT_DB_VERSION = 6;

export function initDatabase(
    db: IDBDatabase,
    oldVersion: number,
    transaction: IDBTransaction | null,
): void {
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
        if (!vtxosStore.indexNames.contains("script")) {
            vtxosStore.createIndex("script", "script", {
                unique: false,
            });
        }
        vtxosStore.createIndex("scriptUnspent", ["script", "unspent"], {
            unique: false,
        });
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
            keyPath: ["address", "keyBoardingTxid", "keyCommitmentTxid", "keyArkTxid"],
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
    if (!db.objectStoreNames.contains(STORE_CONTRACTS)) {
        const contractsStore = db.createObjectStore(STORE_CONTRACTS, {
            keyPath: "script",
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
    }

    if (!db.objectStoreNames.contains(LEGACY_STORE_CONTRACT_COLLECTIONS)) {
        db.createObjectStore(LEGACY_STORE_CONTRACT_COLLECTIONS, {
            keyPath: "key",
        });
    }

    // v2 → v3: add the `script` index on the existing vtxos store and
    // backfill missing `script` on legacy VTXO rows. The upgrade transaction
    // is null only on a brand-new database (oldVersion === 0), where no
    // legacy rows exist. `createIndex` scans existing records; rows still
    // missing `script` are skipped and get indexed automatically when the
    // backfill's `cursor.update()` adds the field.
    if (oldVersion >= 1 && oldVersion < 3 && transaction) {
        const vtxosStore = transaction.objectStore(STORE_VTXOS);
        if (!vtxosStore.indexNames.contains("script")) {
            vtxosStore.createIndex("script", "script", { unique: false });
        }
        // The v6 backfill below fills both script and unspent in one
        // cursor pass, avoiding two concurrent updates to the same legacy row.
    }

    if (oldVersion >= 1 && oldVersion < 6 && transaction) {
        const vtxosStore = transaction.objectStore(STORE_VTXOS);
        if (!vtxosStore.indexNames.contains("scriptUnspent")) {
            vtxosStore.createIndex("scriptUnspent", ["script", "unspent"], {
                unique: false,
            });
        }
        backfillUnspentVtxos(transaction);
    }
}

/** Populate the unspent index without dropping any historical VTXO rows. */
export function backfillUnspentVtxos(transaction: IDBTransaction): void {
    const request = transaction.objectStore(STORE_VTXOS).openCursor();
    request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const value = cursor.value as {
            address: string;
            script?: string;
            unspent?: 1;
            isSpent?: boolean;
            spentBy?: string;
            settledBy?: string;
            virtualStatus?: { state?: string };
        };
        let script = value.script;
        if (!script) {
            try {
                script = scriptFromArkAddress(value.address);
            } catch {
                // Keep a corrupt legacy row in history; it cannot enter the
                // active index without a trustworthy owner script.
                cursor.continue();
                return;
            }
        }
        const unspent = unspentIndexFlagForVtxo({ ...value, script });
        if (value.script !== script || value.unspent !== unspent) {
            value.script = script;
            if (unspent) value.unspent = unspent;
            else delete value.unspent;
            cursor.update(value);
        }
        cursor.continue();
    };
}

// Experimental / inert: creates the intent, virtualtx and vtxoBranch stores on
// top of the shared wallet schema. Invoked ONLY by the opt-in
// `IndexedDBIntentRepository`/`IndexedDBVirtualTxRepository` when they open a
// dedicated DB at `INTENT_DB_VERSION`. The default wallet path uses
// `initDatabase` and never reaches this code, so an existing user's database is
// never upgraded to hold these stores.
export function initDatabaseWithIntents(
    db: IDBDatabase,
    oldVersion: number,
    transaction: IDBTransaction | null,
): void {
    initDatabase(db, oldVersion, transaction);

    // v4: intent + virtualtx persistence
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

    // v4 → v5: the intents store already exists with a NON-unique intentId
    // index; recreate it as unique. Only oldVersion === 4 hits this — a store
    // created fresh (or via a <4 upgrade) already gets the unique index above.
    if (oldVersion === 4 && transaction) {
        const intentsStore = transaction.objectStore(STORE_INTENTS);
        if (intentsStore.indexNames.contains("intentId")) {
            intentsStore.deleteIndex("intentId");
        }
        // The v4 index was non-unique, so duplicate intentId values may exist.
        // Building the unique index directly would abort the whole upgrade on
        // the first collision, so drop duplicate rows first (keeping the first
        // seen per intentId), then create the index once the store is clean.
        // Absent/null intentIds are never indexed and can't collide.
        dedupeIntentIds(intentsStore, () => {
            intentsStore.createIndex("intentId", "intentId", { unique: true });
        });
    }
}

// Walk the intents store, deleting rows whose `intentId` repeats an
// already-seen value, then invoke `onComplete` once the walk finishes. The
// version-change transaction stays open while the cursor requests are pending,
// and every delete is applied before the terminal (null-cursor) callback, so
// `onComplete` observes a store free of duplicate intentIds.
function dedupeIntentIds(store: IDBObjectStore, onComplete: () => void): void {
    const seen = new Set<string>();
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
            onComplete();
            return;
        }
        const id = (cursor.value as { intentId?: string | null }).intentId;
        if (id != null) {
            if (seen.has(id)) {
                cursor.delete();
            } else {
                seen.add(id);
            }
        }
        cursor.continue();
    };
}

// Exported for unit tests — the `onupgradeneeded` transaction can't be
// forged in-process, so tests exercise the cursor logic with a regular
// readwrite transaction on a live DB.
export function backfillVtxoScripts(transaction: IDBTransaction): void {
    const store = transaction.objectStore(STORE_VTXOS);
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const value = cursor.value as { script?: string; address: string };
        if (!value.script) {
            value.script = scriptFromArkAddress(value.address);
            cursor.update(value);
        }
        cursor.continue();
    };
}
