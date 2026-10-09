import { describe, it, expect } from "vitest";
import { openDatabase, closeDatabase } from "../src/repositories/indexedDB/manager";
import {
    initDatabase,
    DB_VERSION,
    STORE_CONTRACTS,
    STORE_INTENTS,
    STORE_TRANSACTIONS,
} from "../src/repositories/indexedDB/schema";
import { awaitTransaction, promisifyRequest } from "../src/repositories/indexedDB/idbUtils";
import { IndexedDBContractRepository } from "../src/repositories/indexedDB/contractRepository";
import { collectContracts, type ContractFilter } from "../src/repositories/contractRepository";
import { IndexedDBIntentRepository } from "../src/repositories/indexedDB/intentRepository";
import { IndexedDBVirtualTxRepository } from "../src/repositories/indexedDB/virtualTxRepository";
import { collectIntents } from "../src/repositories/intentRepository";

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
    it("creates the intent/virtualtx/branch stores in the shared schema", async () => {
        expect(DB_VERSION).toBe(6);
        const db = await openDatabase("schema-shared-fresh-test", DB_VERSION, initDatabase);
        const names = Array.from(db.objectStoreNames);
        expect(
            db
                .transaction(STORE_TRANSACTIONS, "readonly")
                .objectStore(STORE_TRANSACTIONS)
                .indexNames.contains("addressCreatedAt"),
        ).toBe(true);
        expect(names).toEqual(expect.arrayContaining(["intents", "virtualTxs", "vtxoBranches"]));
        expect(indexIsUnique(db, STORE_INTENTS, "intentId")).toBe(true);
        await closeDatabase("schema-shared-fresh-test");
    });

    it("adds the intent stores to a v5 wallet database, keeping its rows", async () => {
        const name = "schema-wallet-v5-to-v6-test";
        // A v5 wallet database: every wallet store, no intent store.
        const v5 = await openDatabase(name, 5, (db, oldVersion, transaction) => {
            initDatabase(db, oldVersion, transaction);
            for (const store of ["intents", "virtualTxs", "vtxoBranches"])
                db.deleteObjectStore(store);
        });
        expect(Array.from(v5.objectStoreNames)).not.toContain("intents");
        await put(v5, STORE_CONTRACTS, {
            script: "s1",
            address: "a1",
            type: "default",
            state: "active",
            params: {},
            createdAt: 1,
            watchState: "watched",
        });
        await closeDatabase(name);

        const v6 = await openDatabase(name, DB_VERSION, initDatabase);
        expect(Array.from(v6.objectStoreNames)).toEqual(
            expect.arrayContaining(["intents", "virtualTxs", "vtxoBranches"]),
        );
        expect(indexIsUnique(v6, STORE_INTENTS, "intentId")).toBe(true);
        expect(await countRows(v6, STORE_CONTRACTS)).toBe(1);
        await closeDatabase(name);
    });

    it("keeps the intents of a database the dedicated intent ladder created at v5", async () => {
        const name = "schema-intent-v5-to-v6-test";
        const v5 = await openDatabase(name, 5, (db) => {
            const s = db.createObjectStore(STORE_INTENTS, { keyPath: "intentTxId" });
            s.createIndex("intentId", "intentId", { unique: true });
            s.createIndex("state", "state", { unique: false });
        });
        await put(v5, STORE_INTENTS, { intentTxId: "a", intentId: "srv1", state: "batch_started" });
        await closeDatabase(name);

        const v6 = await openDatabase(name, DB_VERSION, initDatabase);
        expect(await countRows(v6, STORE_INTENTS)).toBe(1);
        expect(indexIsUnique(v6, STORE_INTENTS, "intentId")).toBe(true);
        await closeDatabase(name);
    });

    // On the default name, the wallet/contract and intent/virtualtx repositories open one
    // database: they must agree on its version and schema whichever opens first.
    for (const intentFirst of [false, true]) {
        it(`shares one database with the contract repository (${intentFirst ? "intent" : "contract"} repository first)`, async () => {
            const name = `schema-shared-name-${intentFirst ? "intent" : "contract"}-first`;
            const contracts = new IndexedDBContractRepository(name);
            const intents = new IndexedDBIntentRepository(name);
            const virtualTxs = new IndexedDBVirtualTxRepository(name);
            const readContracts = () => collectContracts(contracts, {});
            const readIntents = () => collectIntents(intents, {});
            try {
                if (intentFirst) {
                    await expect(readIntents()).resolves.toEqual([]);
                    await expect(readContracts()).resolves.toEqual([]);
                } else {
                    await expect(readContracts()).resolves.toEqual([]);
                    await expect(readIntents()).resolves.toEqual([]);
                }
                await expect(virtualTxs.getVirtualTx("00".repeat(32))).resolves.toBeNull();
            } finally {
                await virtualTxs[Symbol.asyncDispose]();
                await intents[Symbol.asyncDispose]();
                await contracts[Symbol.asyncDispose]();
            }
        });
    }

    it("migrates a dedicated-ladder v4 database to a unique intentId index", async () => {
        const name = "schema-v4-to-v5-test";

        // Reproduce the old v4 intents store: NON-unique intentId index, one row.
        const v4 = await openDatabase(name, 4, (db) => {
            const s = db.createObjectStore(STORE_INTENTS, { keyPath: "intentTxId" });
            s.createIndex("intentId", "intentId", { unique: false });
        });
        expect(indexIsUnique(v4, STORE_INTENTS, "intentId")).toBe(false);
        await put(v4, STORE_INTENTS, { intentTxId: "a", intentId: "srv1" });
        await closeDatabase(name);

        // Reopen at the shared version: the upgrade must rebuild the index.
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

    describe("v5 to v6: contracts indexed by watch state", () => {
        const contract = (script: string, type: string, watch?: string) => ({
            script,
            address: `address-${script}`,
            type,
            state: "active",
            params: {},
            createdAt: 1,
            ...(watch && { watch }),
        });
        const rows = [
            contract("legacy", "default"),
            contract("s1", "default", "watched"),
            contract("s2", "default", "awaiting-funds"),
            contract("s3", "default", "retained"),
            contract("v1", "vhtlc"),
        ];

        // The v5 contracts store, holding rows as v5 wrote them.
        async function seedV5(name: string) {
            const db = await openDatabase(name, 5, (db, oldVersion, transaction) => {
                initDatabase(db, oldVersion, transaction);
                const store = transaction!.objectStore(STORE_CONTRACTS);
                for (const index of Array.from(store.indexNames)) {
                    if (index !== "type" && index !== "state") store.deleteIndex(index);
                }
            });
            const tx = db.transaction(STORE_CONTRACTS, "readwrite");
            for (const row of rows) tx.objectStore(STORE_CONTRACTS).put(row);
            await awaitTransaction(tx);
            await closeDatabase(name);
        }
        const watchedKeys = (db: IDBDatabase) =>
            promisifyRequest(
                db
                    .transaction(STORE_CONTRACTS, "readonly")
                    .objectStore(STORE_CONTRACTS)
                    .index("watchState")
                    .getAllKeys(IDBKeyRange.bound(["watched"], ["watched", []])),
            );

        it("indexes every existing contract, one without a state as watched", async () => {
            const name = `contracts-v5-${crypto.randomUUID()}`;
            await seedV5(name);

            await using repository = new IndexedDBContractRepository(name);
            const scripts = async (filter: ContractFilter) =>
                (await collectContracts(repository, filter)).map((c) => c.script);
            expect(await scripts({ watch: ["watched", "awaiting-funds"] })).toEqual([
                "legacy",
                "s1",
                "s2",
                "v1",
            ]);
            expect(await scripts({ type: "default", watch: "watched" })).toEqual(["legacy", "s1"]);
            expect(await scripts({ watch: "retained" })).toEqual(["s3"]);
            expect((await collectContracts(repository, { script: "legacy" }))[0]).toEqual(rows[0]);

            const db = await openDatabase(name, DB_VERSION, initDatabase);
            try {
                expect(db.version).toBe(DB_VERSION);
                expect(await watchedKeys(db)).toEqual(["legacy", "s1", "v1"]);
            } finally {
                await closeDatabase(name);
            }
        });

        it("leaves v5 untouched when the upgrade aborts, and the next open completes it", async () => {
            const name = `contracts-v5-abort-${crypto.randomUUID()}`;
            await seedV5(name);

            await expect(
                openDatabase(name, DB_VERSION, (db, oldVersion, transaction) => {
                    initDatabase(db, oldVersion, transaction);
                    transaction!.abort();
                }),
            ).rejects.toThrow();
            const v5 = await openDatabase(name, 5, () => {});
            try {
                const store = v5
                    .transaction(STORE_CONTRACTS, "readonly")
                    .objectStore(STORE_CONTRACTS);
                expect(v5.version).toBe(5);
                expect(Array.from(store.indexNames).sort()).toEqual(["state", "type"]);
                expect(await promisifyRequest(store.getAll())).toEqual(rows);
            } finally {
                await closeDatabase(name);
            }

            await using repository = new IndexedDBContractRepository(name);
            const watched = await collectContracts(repository, { watch: "watched" });
            expect(watched.map((c) => c.script)).toEqual(["legacy", "s1", "v1"]);
        });
    });
});
