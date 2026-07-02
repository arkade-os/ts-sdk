import { describe, it, expect } from "vitest";
import { openDatabase } from "../src/repositories/indexedDB/manager";
import { initDatabase, DB_VERSION } from "../src/repositories/indexedDB/schema";

// IndexedDB is provided globally by test/polyfill.js (indexeddbshim);
// no per-file shim import needed — matches existing IDB repo tests.

describe("IndexedDB schema v4", () => {
    it("creates intent + virtualtx + branch stores", async () => {
        expect(DB_VERSION).toBe(4);
        const db = await openDatabase("schema-v4-test", DB_VERSION, initDatabase);
        const names = Array.from(db.objectStoreNames);
        expect(names).toEqual(expect.arrayContaining(["intents", "virtualTxs", "vtxoBranches"]));
        db.close();
    });
});
