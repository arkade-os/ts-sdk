import { intentRepositoryConformance } from "./conformance/intentRepository.conformance";
import { SQLiteBatchRegistrationRepository } from "../src/repositories/sqlite/intentRepository";
import { createNodeSQLExecutor } from "../../../config/test-helpers/nodeSqlExecutor";
import { expect, it, vi } from "vitest";

// Real node:sqlite (not the regex mock): the intent upsert uses
// `ON CONFLICT ... DO UPDATE` and a partial unique index on intent_id, which
// only a real engine parses and enforces.
intentRepositoryConformance(
    "sqlite",
    async () => new SQLiteBatchRegistrationRepository(createNodeSQLExecutor()),
);

it("filters selective intent states in one SQLite page query", async () => {
    const db = createNodeSQLExecutor();
    const repository = new SQLiteBatchRegistrationRepository(db);
    const makeIntent = (proofTxId: string, state: "cancelled" | "waiting_for_batch") => ({
        proofTxId,
        state,
        createdAt: 1,
        updatedAt: 1,
        registerProof: "rp",
        registerProofMessage: "rpm",
        deleteProof: "dp",
        deleteProofMessage: "dpm",
        partialForfeits: [],
        proofInputs: [],
    });
    for (let i = 0; i < 200; i++) {
        await repository.saveBatchRegistration(
            makeIntent(`a${String(i).padStart(3, "0")}`, "cancelled"),
        );
    }
    for (let i = 0; i < 5; i++) {
        await repository.saveBatchRegistration(makeIntent(`z${i}`, "waiting_for_batch"));
    }

    const all = vi.spyOn(db, "all");
    const filter = { states: ["waiting_for_batch" as const] };
    const first = await repository.getBatchRegistrationsPage(filter, { limit: 2 });
    expect(first.items.map((intent) => intent.proofTxId)).toEqual(["z0", "z1"]);
    expect(first.nextCursor).toBe("z1");
    expect(all).toHaveBeenCalledTimes(1);
    all.mockClear();
    const second = await repository.getBatchRegistrationsPage(filter, {
        limit: 2,
        after: first.nextCursor,
    });
    expect(second.items.map((intent) => intent.proofTxId)).toEqual(["z2", "z3"]);
    expect(all).toHaveBeenCalledTimes(1);
    expect(
        (await repository.getBatchRegistrationsPage({ states: [] }, { limit: 2 })).items,
    ).toEqual([]);
});
