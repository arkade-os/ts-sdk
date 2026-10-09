import { scriptFromArkAddress } from "../scriptFromAddress";
import { legacyFactsOfRow } from "../legacyVtxoFacts";
import { isVtxoSpent } from "../../wallet/vtxo";
import type { VirtualCoin } from "../../wallet";
import { type Contract, type ContractWatchState, watchStateOf } from "../../contracts/types";

// Store names introduced in V2, they are all new to the migration
export const STORE_VTXOS = "vtxos";
export const STORE_UTXOS = "utxos";
export const STORE_TRANSACTIONS = "transactions";
export const STORE_WALLET_STATE = "walletState";
export const STORE_CONTRACTS = "contracts";
export const STORE_INTENTS = "intents";
export const STORE_VIRTUAL_TXS = "virtualTxs";
export const STORE_VTXO_BRANCHES = "vtxoBranches";

// Version history:
//   v1 — initial wallet repo schema, `contractsCollections` store.
//   v2 — new `vtxos/utxos/transactions/walletState/contracts` stores.
//   v3 — add `script` index on the vtxos store and backfill missing
//        `vtxo.script` from `vtxo.address` so the field is always present
//        at read time. Matches the `script` indexing already in place for
//        Realm (`realm/schemas.ts`) and SQLite (`sqlite/walletRepository.ts`).
//   v4 — add the `scriptUnspent` index; existing rows are backfilled.
//   v5 — add the `(address, createdAt)` history index; existing rows are
//        indexed without changing their stored values.
//   v6 — add the contract watch-state indexes; existing rows are backfilled.
//        Add the `intents`, `virtualTxs` and `vtxoBranches` stores (new, empty),
//        so the intent and virtual-tx repositories share the wallet database.
//        A database the retired dedicated intent ladder created already has
//        them; its v4 non-unique `intents.intentId` index is rebuilt unique.
// An older SDK cannot reopen a newer database.
export const DB_VERSION = 6;

export const CONTRACT_WATCH_INDEX = "watchState";
export const CONTRACT_TYPE_WATCH_INDEX = "typeWatchState";

/** A stored contract. `watchState` is what the watch indexes key on: an index skips
 * a record missing its key path, and a contract without `watch` counts as watched. */
export type ContractRow = Contract & { watchState: ContractWatchState };

export const contractRow = (contract: Contract): ContractRow => ({
    ...contract,
    watchState: watchStateOf(contract),
});

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
        if (!vtxosStore.indexNames.contains("scriptUnspent")) {
            vtxosStore.createIndex("scriptUnspent", ["script", "unspent"], { unique: false });
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
        if (!transactionsStore.indexNames.contains("addressCreatedAt")) {
            transactionsStore.createIndex("addressCreatedAt", ["address", "createdAt"], {
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
        createContractWatchIndexes(contractsStore);
    }

    // v1–v3 → v4: one cursor pass backfills both indexed fields. `transaction`
    // is null only on a brand-new database, where no legacy rows exist.
    if (oldVersion >= 1 && oldVersion < 4 && transaction) {
        const vtxosStore = transaction.objectStore(STORE_VTXOS);
        if (!vtxosStore.indexNames.contains("script")) {
            vtxosStore.createIndex("script", "script", { unique: false });
        }
        if (!vtxosStore.indexNames.contains("scriptUnspent")) {
            vtxosStore.createIndex("scriptUnspent", ["script", "unspent"], { unique: false });
        }
        backfillVtxoIndexFields(transaction);
    }

    if (oldVersion > 0 && transaction) {
        const transactionsStore = transaction.objectStore(STORE_TRANSACTIONS);
        if (!transactionsStore.indexNames.contains("addressCreatedAt")) {
            transactionsStore.createIndex("addressCreatedAt", ["address", "createdAt"], {
                unique: false,
            });
        }
    }

    if (oldVersion > 0 && oldVersion < 6 && transaction) {
        const contractsStore = transaction.objectStore(STORE_CONTRACTS);
        createContractWatchIndexes(contractsStore);
        backfillContractWatchState(contractsStore);
    }

    createIntentStores(db);
    // Only a store the dedicated ladder created at its v4 can hold the non-unique index.
    if (transaction && !indexIsUnique(transaction.objectStore(STORE_INTENTS), "intentId")) {
        const intentsStore = transaction.objectStore(STORE_INTENTS);
        if (intentsStore.indexNames.contains("intentId")) intentsStore.deleteIndex("intentId");
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

function createIntentStores(db: IDBDatabase): void {
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

// A missing index counts as not unique, so the repair above recreates it.
const indexIsUnique = (store: IDBObjectStore, name: string): boolean =>
    store.indexNames.contains(name) && store.index(name).unique;

function createContractWatchIndexes(store: IDBObjectStore): void {
    if (!store.indexNames.contains(CONTRACT_WATCH_INDEX)) {
        store.createIndex(CONTRACT_WATCH_INDEX, ["watchState", "script"], { unique: false });
    }
    if (!store.indexNames.contains(CONTRACT_TYPE_WATCH_INDEX)) {
        store.createIndex(CONTRACT_TYPE_WATCH_INDEX, ["type", "watchState", "script"], {
            unique: false,
        });
    }
}

// Inside the upgrade transaction, so an interrupted run commits nothing and the next open repeats it.
function backfillContractWatchState(store: IDBObjectStore): void {
    const pageSize = 1000;
    const readPage = (after?: string) => {
        const request = store.getAll(
            after === undefined ? undefined : IDBKeyRange.lowerBound(after, true),
            pageSize,
        );
        request.onsuccess = () => {
            const rows = request.result as ContractRow[];
            for (const row of rows) {
                const next = contractRow(row);
                if (next.watchState !== row.watchState) store.put(next);
            }
            const last = rows.at(-1);
            if (rows.length === pageSize && last) readPage(last.script);
        };
    };
    readPage();
}

// Booleans are not valid IndexedDB keys, so unspent rows carry `unspent: 1`
// to enter the `scriptUnspent` index; spent history stays out of it.
export const unspentFlag = (vtxo: VirtualCoin): { unspent?: 1 } =>
    isVtxoSpent(vtxo) ? {} : { unspent: 1 };

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
// forged in-process, so tests exercise the backfill with a regular
// readwrite transaction on a live DB.
export function backfillVtxoIndexFields(transaction: IDBTransaction): void {
    const store = transaction.objectStore(STORE_VTXOS);
    const pageSize = 1000;
    // Paged getAll, not a cursor: a cursor pays one event per row.
    const readPage = (after?: IDBValidKey) => {
        const request = store.getAll(after && IDBKeyRange.lowerBound(after, true), pageSize);
        request.onsuccess = () => {
            const rows = request.result as (VirtualCoin & { address: string; unspent?: 1 })[];
            for (const value of rows) {
                // Same legacy repair the read path applies, so the flag matches what reads return.
                const legacy = legacyFactsOfRow(value);
                const next = {
                    ...value,
                    script: value.script || scriptFromArkAddress(value.address),
                    ...unspentFlag({ ...value, isSpent: value.isSpent ?? legacy?.isSpent }),
                };
                if (next.script !== value.script || next.unspent !== value.unspent) {
                    store.put(next);
                }
            }
            const last = rows.at(-1);
            if (rows.length === pageSize && last) readPage([last.address, last.txid, last.vout]);
        };
    };
    readPage();
}
