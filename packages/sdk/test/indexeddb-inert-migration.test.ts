import { describe, it, expect } from "vitest";
import { openDatabase, closeDatabase } from "../src/repositories/indexedDB/manager";
import { initDatabase, DB_VERSION } from "../src/repositories/indexedDB/schema";
import { IndexedDBWalletRepository } from "../src/repositories/indexedDB/walletRepository";
import { IndexedDBContractRepository } from "../src/repositories/indexedDB/contractRepository";

// IndexedDB is provided globally by test/polyfill.js (indexeddbshim).

// Inertness guarantee: the default wallet + contract repositories share one DB
// at DB_VERSION and never bump it or create the intent-persistence stores.
describe("IndexedDB default path is inert", () => {
    async function storeNames(dbName: string): Promise<{ version: number; names: string[] }> {
        // Opening at DB_VERSION returns the repos' cached connection (refcount++),
        // so we can read its version/stores without triggering an upgrade.
        const db = await openDatabase(dbName, DB_VERSION, initDatabase);
        const result = { version: db.version, names: Array.from(db.objectStoreNames) };
        await closeDatabase(dbName);
        return result;
    }

    it("never upgrades an existing v4 database or adds intent stores", async () => {
        const dbName = `inert-existing-v4-${Date.now()}`;

        // Seed a pre-existing database at the shared v4 schema and close it.
        const seeded = await openDatabase(dbName, DB_VERSION, initDatabase);
        expect(seeded.version).toBe(4);
        await closeDatabase(dbName);

        // Open the same DB through the default repos, exercising both.
        const wallet = new IndexedDBWalletRepository(dbName);
        const contract = new IndexedDBContractRepository(dbName);
        try {
            await wallet.getWalletState();
            await contract.getContracts();

            const { version, names } = await storeNames(dbName);
            expect(version).toBe(4);
            expect(names).not.toContain("intents");
            expect(names).not.toContain("virtualTxs");
            expect(names).not.toContain("vtxoBranches");
        } finally {
            await wallet[Symbol.asyncDispose]();
            await contract[Symbol.asyncDispose]();
        }
    });
});
