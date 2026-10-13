import { describe, it, expect } from "vitest";
import { openDatabase, closeDatabase } from "../src/repositories/indexedDB/manager";
import {
    initDatabase,
    DB_VERSION,
    STORE_CONTRACTS,
    STORE_TRANSACTIONS,
} from "../src/repositories/indexedDB/schema";
import {
    BATCHES_DB_NAME,
    BATCHES_DB_VERSION,
    initBatchesDatabase,
    STORE_INTENTS,
} from "../src/repositories/indexedDB/batchesSchema";
import { IndexedDBIntentRepository } from "../src/repositories/indexedDB/intentRepository";
import { IndexedDBVirtualTxRepository } from "../src/repositories/indexedDB/virtualTxRepository";
import { collectIntents } from "../src/repositories/intentRepository";
import { DEFAULT_DB_NAME } from "../src/worker/browser/utils";
import { awaitTransaction, promisifyRequest } from "../src/repositories/indexedDB/idbUtils";
import { IndexedDBContractRepository } from "../src/repositories/indexedDB/contractRepository";
import { collectContracts, type ContractFilter } from "../src/repositories/contractRepository";

// IndexedDB is provided globally by test/polyfill.js (indexeddbshim);
// no per-file shim import needed — matches existing IDB repo tests.

function indexIsUnique(db: IDBDatabase, store: string, index: string): boolean {
    return db.transaction(store, "readonly").objectStore(store).index(index).unique;
}

describe("IndexedDB schema", () => {
    // The shared wallet/contract schema adds a history index at v5 and contract
    // watch indexes at v6; the intent-persistence stores live in the batches database.
    it("keeps intent/virtualtx stores out of the shared v6 schema", async () => {
        expect(DB_VERSION).toBe(6);
        const db = await openDatabase("schema-shared-inert-test", DB_VERSION, initDatabase);
        const names = Array.from(db.objectStoreNames);
        expect(
            db
                .transaction(STORE_TRANSACTIONS, "readonly")
                .objectStore(STORE_TRANSACTIONS)
                .indexNames.contains("addressCreatedAt"),
        ).toBe(true);
        expect(names).not.toContain("intents");
        expect(names).not.toContain("virtualTxs");
        expect(names).not.toContain("vtxoBranches");
        await closeDatabase("schema-shared-inert-test");
    });

    it("creates the intent/virtualtx/branch stores in the batches database", async () => {
        const db = await openDatabase(
            "schema-batches-fresh-test",
            BATCHES_DB_VERSION,
            initBatchesDatabase,
        );
        const names = Array.from(db.objectStoreNames);
        expect(names).toEqual(expect.arrayContaining(["intents", "virtualTxs", "vtxoBranches"]));
        expect(names).not.toContain(STORE_CONTRACTS);
        expect(indexIsUnique(db, STORE_INTENTS, "intentId")).toBe(true);
        await closeDatabase("schema-batches-fresh-test");
    });

    // Default names: the intent/virtualtx repositories must never open the wallet database.
    it("keeps the intent/virtualtx repositories out of the wallet database", async () => {
        expect(BATCHES_DB_NAME).not.toBe(DEFAULT_DB_NAME);
        const contracts = new IndexedDBContractRepository();
        const intents = new IndexedDBIntentRepository();
        const virtualTxs = new IndexedDBVirtualTxRepository();
        try {
            // intent repository first: on a shared name it would fix the version
            await expect(collectIntents(intents, {})).resolves.toEqual([]);
            await expect(collectContracts(contracts, {})).resolves.toEqual([]);
            await expect(virtualTxs.getVirtualTx("00".repeat(32))).resolves.toBeNull();
        } finally {
            await virtualTxs[Symbol.asyncDispose]();
            await intents[Symbol.asyncDispose]();
            await contracts[Symbol.asyncDispose]();
        }
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
                expect(db.version).toBe(6);
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
