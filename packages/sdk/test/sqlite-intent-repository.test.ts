import { intentRepositoryConformance } from "./conformance/intentRepository.conformance";
import { SQLiteIntentRepository } from "../src/repositories/sqlite/intentRepository";
import { createNodeSQLExecutor } from "../../../config/test-helpers/nodeSqlExecutor";
import { expect, it, vi } from "vitest";
import { collectIntents } from "../src/repositories/intentRepository";

// Real node:sqlite (not the regex mock): the intent upsert uses
// `ON CONFLICT ... DO UPDATE` and a partial unique index on intent_id, which
// only a real engine parses and enforces.
intentRepositoryConformance(
    "sqlite",
    async () => new SQLiteIntentRepository(createNodeSQLExecutor()),
);

it("filters selective intent states in one SQLite page query", async () => {
    const db = createNodeSQLExecutor();
    const repository = new SQLiteIntentRepository(db);
    const makeIntent = (intentTxId: string, state: "cancelled" | "waiting_for_batch") => ({
        intentTxId,
        state,
        createdAt: 1,
        updatedAt: 1,
        registerProof: "rp",
        registerProofMessage: "rpm",
        deleteProof: "dp",
        deleteProofMessage: "dpm",
        partialForfeits: [],
        intentVtxos: [],
    });
    for (let i = 0; i < 200; i++) {
        await repository.saveIntent(makeIntent(`a${String(i).padStart(3, "0")}`, "cancelled"));
    }
    for (let i = 0; i < 5; i++) {
        await repository.saveIntent(makeIntent(`z${i}`, "waiting_for_batch"));
    }

    const all = vi.spyOn(db, "all");
    const filter = { states: ["waiting_for_batch" as const] };
    const first = await repository.getIntentsPage(filter, { limit: 2 });
    expect(first.items.map((intent) => intent.intentTxId)).toEqual(["z0", "z1"]);
    expect(first.nextCursor).toBe("z1");
    expect(all).toHaveBeenCalledTimes(1);
    all.mockClear();
    const second = await repository.getIntentsPage(filter, { limit: 2, after: first.nextCursor });
    expect(second.items.map((intent) => intent.intentTxId)).toEqual(["z2", "z3"]);
    expect(all).toHaveBeenCalledTimes(1);
    expect((await repository.getIntentsPage({ states: [] }, { limit: 2 })).items).toEqual([]);
});

it("migrates an intents table created before noMatchSeenAt", async () => {
    const db = createNodeSQLExecutor();
    await db.run(`CREATE TABLE ark_intents (
        intent_tx_id TEXT PRIMARY KEY,
        intent_id TEXT,
        state TEXT NOT NULL,
        valid_from INTEGER,
        valid_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        register_proof TEXT NOT NULL,
        register_proof_message TEXT NOT NULL,
        delete_proof TEXT NOT NULL,
        delete_proof_message TEXT NOT NULL,
        batch_id TEXT,
        commitment_txid TEXT,
        cancellation_reason TEXT,
        partial_forfeits_json TEXT NOT NULL,
        signer_descriptor TEXT,
        intent_vtxos_json TEXT NOT NULL
    )`);
    await db.run(
        `INSERT INTO ark_intents VALUES ('old', NULL, 'waiting_for_batch', NULL, NULL, 1, 1,
         'rp', 'rpm', 'dp', 'dpm', NULL, NULL, NULL, '[]', NULL, '[]')`,
    );

    const repository = new SQLiteIntentRepository(db);
    const [old] = await collectIntents(repository, { intentTxIds: ["old"] });
    expect(old.noMatchSeenAt).toBeUndefined();

    await repository.saveIntent({ ...old, noMatchSeenAt: 99 });
    const [after] = await collectIntents(repository, { intentTxIds: ["old"] });
    expect(after.noMatchSeenAt).toBe(99);
});
