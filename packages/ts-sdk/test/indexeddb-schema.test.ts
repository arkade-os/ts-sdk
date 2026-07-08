import { describe, it, expect } from "vitest";
import { openDatabase, closeDatabase } from "../src/repositories/indexedDB/manager";
import { initDatabase, DB_VERSION, STORE_INTENTS } from "../src/repositories/indexedDB/schema";

// IndexedDB is provided globally by test/polyfill.js (indexeddbshim);
// no per-file shim import needed — matches existing IDB repo tests.

function indexIsUnique(db: IDBDatabase, store: string, index: string): boolean {
    return db.transaction(store, "readonly").objectStore(store).index(index).unique;
}

function put(db: IDBDatabase, store: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const req = tx.objectStore(store).put(value);
        // Resolve on commit (tx.oncomplete), not req.onsuccess: a request can
        // succeed and still be rolled back if the transaction later aborts.
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? req.error);
    });
}

function countRows(db: IDBDatabase, store: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = db.transaction(store, "readonly").objectStore(store).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

describe("IndexedDB schema", () => {
    it("creates the intent/virtualtx/branch stores with a unique intentId index", async () => {
        expect(DB_VERSION).toBe(5);
        const db = await openDatabase("schema-fresh-test", DB_VERSION, initDatabase);
        const names = Array.from(db.objectStoreNames);
        expect(names).toEqual(expect.arrayContaining(["intents", "virtualTxs", "vtxoBranches"]));
        expect(indexIsUnique(db, STORE_INTENTS, "intentId")).toBe(true);
        await closeDatabase("schema-fresh-test");
    });

    it("migrates an existing v4 database to a unique intentId index", async () => {
        const name = "schema-v4-to-v5-test";

        // Reproduce the old v4 intents store: NON-unique intentId index, one row.
        const v4 = await openDatabase(name, 4, (db) => {
            const s = db.createObjectStore(STORE_INTENTS, { keyPath: "intentTxId" });
            s.createIndex("intentId", "intentId", { unique: false });
        });
        expect(indexIsUnique(v4, STORE_INTENTS, "intentId")).toBe(false);
        await put(v4, STORE_INTENTS, { intentTxId: "a", intentId: "srv1" });
        await closeDatabase(name);

        // Reopen at the current version: the upgrade must rebuild the index.
        const v5 = await openDatabase(name, DB_VERSION, initDatabase);
        expect(indexIsUnique(v5, STORE_INTENTS, "intentId")).toBe(true);
        // ...and it now rejects a second row reusing the same intentId.
        await expect(
            put(v5, STORE_INTENTS, { intentTxId: "b", intentId: "srv1" }),
        ).rejects.toThrow();
        await closeDatabase(name);
    });

    it("drops duplicate intentIds when migrating a v4 database to the unique index", async () => {
        const name = "schema-v4-dupes-to-v5-test";

        // A v4 non-unique index let several rows share one intentId. Absent
        // intentIds aren't indexed, so they must survive untouched.
        const v4 = await openDatabase(name, 4, (db) => {
            const s = db.createObjectStore(STORE_INTENTS, { keyPath: "intentTxId" });
            s.createIndex("intentId", "intentId", { unique: false });
        });
        await put(v4, STORE_INTENTS, { intentTxId: "a", intentId: "srv1" });
        await put(v4, STORE_INTENTS, { intentTxId: "b", intentId: "srv1" });
        await put(v4, STORE_INTENTS, { intentTxId: "c", intentId: "srv2" });
        await put(v4, STORE_INTENTS, { intentTxId: "d" }); // no intentId
        await closeDatabase(name);

        // The upgrade must complete despite the duplicate, dropping the extra
        // row and leaving a working unique index behind.
        const v5 = await openDatabase(name, DB_VERSION, initDatabase);
        expect(indexIsUnique(v5, STORE_INTENTS, "intentId")).toBe(true);
        // One duplicate removed: srv1 collapses to a single row, srv2 and the
        // intentId-less row stay.
        expect(await countRows(v5, STORE_INTENTS)).toBe(3);
        // The deduped index is genuinely unique now.
        await expect(
            put(v5, STORE_INTENTS, { intentTxId: "e", intentId: "srv2" }),
        ).rejects.toThrow();
        await closeDatabase(name);
    });
});
