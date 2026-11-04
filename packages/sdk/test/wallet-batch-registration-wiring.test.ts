import { collectBatchRegistrations } from "../src/repositories/batchRegistrationRepository";
import { describe, it, expect } from "vitest";
import { InMemoryBatchRegistrationRepository } from "../src/repositories/inMemory/batchRegistrationRepository";
import { applySettlementEventToRegistration } from "../src/wallet/batchRegistrationStateReducer";
import { SettlementEventType } from "../src/providers/ark";
import type { BatchRegistration } from "../src/repositories/batchRegistrationRepository";

// Exercises the persist + event-reduce contract the settle() path relies on:
// waiting_to_submit -> waiting_for_batch -> (BatchFinalized) batch_succeeded,
// and that a succeeded intent no longer locks its VTXOs.
describe("settle registration persistence contract", () => {
    it("advances state from events and releases locked outpoints when terminal", async () => {
        const repo = new InMemoryBatchRegistrationRepository();
        const base: BatchRegistration = {
            proofTxId: "i1",
            state: "waiting_to_submit",
            createdAt: 1,
            updatedAt: 1,
            registerProof: "rp",
            registerProofMessage: "rpm",
            deleteProof: "dp",
            deleteProofMessage: "dpm",
            partialForfeits: [],
            inputs: [{ txid: "v", vout: 0 }],
        };
        await repo.saveRegistration(base);
        await repo.saveRegistration({ ...base, state: "waiting_for_batch" });

        expect(await repo.getLockedVtxoOutpoints()).toEqual([{ txid: "v", vout: 0 }]);

        const cur = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        const next = applySettlementEventToRegistration(cur, {
            type: SettlementEventType.BatchFinalized,
            id: "batch-1",
            commitmentTxid: "ctx",
        } as never);
        expect(next).toBeDefined();
        if (next) await repo.saveRegistration(next);

        const done = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        expect(done.state).toBe("batch_succeeded");
        expect(done.commitmentTransactionId).toBe("ctx");
        expect(done.batchId).toBe("batch-1");
        expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
    });
});
