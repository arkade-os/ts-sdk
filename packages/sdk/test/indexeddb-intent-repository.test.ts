import { describe, it, expect } from "vitest";
import { intentRepositoryConformance } from "./conformance/intentRepository.conformance";
import { collectIntents } from "../src/repositories/intentRepository";
import { openDatabase, closeDatabase } from "../src/repositories/indexedDB/manager";
import {
    BATCHES_DB_VERSION,
    initBatchesDatabase,
    STORE_INTENTS,
} from "../src/repositories/indexedDB/batchesSchema";
import { IndexedDBIntentRepository } from "../src/repositories/indexedDB/intentRepository";
import { promisifyRequest } from "../src/repositories/indexedDB/idbUtils";

// IndexedDB is provided globally by test/polyfill.js (indexeddbshim).
let n = 0;
intentRepositoryConformance(
    "indexeddb",
    async () => new IndexedDBIntentRepository(`intent-${n++}`),
);

describe("IndexedDBIntentRepository", () => {
    it("reads intentTxIds by key instead of scanning the store", async () => {
        const name = `intent-keyed-${n++}`;
        const repo = new IndexedDBIntentRepository(name);
        const base = {
            state: "waiting_for_batch" as const,
            createdAt: 1,
            updatedAt: 1,
            registerProof: "rp",
            registerProofMessage: "rpm",
            deleteProof: "dp",
            deleteProofMessage: "dpm",
            partialForfeits: [],
            proofInputs: [{ txid: "x", vout: 0 }],
        };
        for (const id of ["a", "b", "c"]) await repo.saveIntent({ ...base, proofTxId: id });
        const db = await openDatabase(name, BATCHES_DB_VERSION, initBatchesDatabase);
        const proto = Object.getPrototypeOf(
            db.transaction([STORE_INTENTS], "readonly").objectStore(STORE_INTENTS),
        ) as { openCursor: (...args: unknown[]) => unknown };
        const original = proto.openCursor;
        let cursors = 0;
        proto.openCursor = function (this: IDBObjectStore, ...args: unknown[]) {
            cursors++;
            return original.apply(this, args);
        };
        try {
            const found = await collectIntents(repo, { proofTxIds: ["b"] });
            expect(found.map((i) => i.proofTxId)).toEqual(["b"]);
        } finally {
            proto.openCursor = original;
            await closeDatabase(name);
            await repo[Symbol.asyncDispose]();
        }
        expect(cursors).toBe(0);
    });

    it("keeps its stored key names, so rows from older releases still read", async () => {
        const name = `intent-stored-${n++}`;
        const repo = new IndexedDBIntentRepository(name);
        const row = {
            intentTxId: "a",
            intentId: "r",
            intentVtxos: [{ txid: "x", vout: 0 }],
            state: "waiting_for_batch" as const,
            createdAt: 1,
            updatedAt: 1,
            registerProof: "rp",
            registerProofMessage: "rpm",
            deleteProof: "dp",
            deleteProofMessage: "dpm",
            partialForfeits: [],
        };
        const db = await openDatabase(name, BATCHES_DB_VERSION, initBatchesDatabase);
        const store = (mode: IDBTransactionMode) =>
            db.transaction([STORE_INTENTS], mode).objectStore(STORE_INTENTS);
        await promisifyRequest(store("readwrite").put(row));

        const [read] = await collectIntents(repo);
        expect(read).toMatchObject({
            proofTxId: "a",
            registrationId: "r",
            proofInputs: row.intentVtxos,
        });

        await repo.saveIntent(read);
        const [stored] = await promisifyRequest(store("readonly").getAll());
        expect(stored).toMatchObject({ intentTxId: "a", intentId: "r" });
        expect(stored).not.toHaveProperty("proofTxId");

        await closeDatabase(name);
        await repo[Symbol.asyncDispose]();
    });
});
