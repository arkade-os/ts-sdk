import { describe, it, expect } from "vitest";
import { intentRepositoryConformance } from "./conformance/intentRepository.conformance";
import { collectIntents } from "../src/repositories/intentRepository";
import { openDatabase, closeDatabase } from "../src/repositories/indexedDB/manager";
import { DB_VERSION, initDatabase, STORE_INTENTS } from "../src/repositories/indexedDB/schema";
import { IndexedDBIntentRepository } from "../src/repositories/indexedDB/intentRepository";

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
            intentVtxos: [{ txid: "x", vout: 0 }],
        };
        for (const id of ["a", "b", "c"]) await repo.saveIntent({ ...base, intentTxId: id });
        const db = await openDatabase(name, DB_VERSION, initDatabase);
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
            const found = await collectIntents(repo, { intentTxIds: ["b"] });
            expect(found.map((i) => i.intentTxId)).toEqual(["b"]);
        } finally {
            proto.openCursor = original;
            await closeDatabase(name);
            await repo[Symbol.asyncDispose]();
        }
        expect(cursors).toBe(0);
    });
});
