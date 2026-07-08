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
        req.onsuccess = () => resolve();
        req.onerror = () => {
            reject(req.error);
        };
        tx.onabort = () => reject(tx.error);
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
});
