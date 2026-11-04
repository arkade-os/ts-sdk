import { describe, it, expect } from "vitest";
import { batchRegistrationRepositoryConformance } from "./conformance/batchRegistrationRepository.conformance";
import { collectBatchRegistrations } from "../src/repositories/batchRegistrationRepository";
import { openDatabase, closeDatabase } from "../src/repositories/indexedDB/manager";
import {
    BATCHES_DB_VERSION,
    initBatchesDatabase,
    STORE_BATCH_REGISTRATIONS,
} from "../src/repositories/indexedDB/batchesSchema";
import { IndexedDBBatchRegistrationRepository } from "../src/repositories/indexedDB/batchRegistrationRepository";

// IndexedDB is provided globally by test/polyfill.js (indexeddbshim).
let n = 0;
batchRegistrationRepositoryConformance(
    "indexeddb",
    async () => new IndexedDBBatchRegistrationRepository(`intent-${n++}`),
);

describe("IndexedDBIntentRepository", () => {
    it("reads intentTxIds by key instead of scanning the store", async () => {
        const name = `intent-keyed-${n++}`;
        const repo = new IndexedDBBatchRegistrationRepository(name);
        const base = {
            state: "waiting_for_batch" as const,
            createdAt: 1,
            updatedAt: 1,
            registerProof: "rp",
            registerProofMessage: "rpm",
            deleteProof: "dp",
            deleteProofMessage: "dpm",
            partialForfeits: [],
            inputs: [{ txid: "x", vout: 0 }],
        };
        for (const id of ["a", "b", "c"]) await repo.saveRegistration({ ...base, proofTxId: id });
        const db = await openDatabase(name, BATCHES_DB_VERSION, initBatchesDatabase);
        const proto = Object.getPrototypeOf(
            db
                .transaction([STORE_BATCH_REGISTRATIONS], "readonly")
                .objectStore(STORE_BATCH_REGISTRATIONS),
        ) as { openCursor: (...args: unknown[]) => unknown };
        const original = proto.openCursor;
        let cursors = 0;
        proto.openCursor = function (this: IDBObjectStore, ...args: unknown[]) {
            cursors++;
            return original.apply(this, args);
        };
        try {
            const found = await collectBatchRegistrations(repo, { proofTxIds: ["b"] });
            expect(found.map((i) => i.proofTxId)).toEqual(["b"]);
        } finally {
            proto.openCursor = original;
            await closeDatabase(name);
            await repo[Symbol.asyncDispose]();
        }
        expect(cursors).toBe(0);
    });
});
