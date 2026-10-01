import { describe, it, expect } from "vitest";
import { InMemoryIntentRepository } from "../src/repositories/inMemory/intentRepository";
import { applySettlementEventToIntent } from "../src/wallet/intentStateReducer";
import { SettlementEventType } from "../src/providers/ark";
import type { ArkIntent } from "../src/repositories/intentRepository";

// Exercises the persist + event-reduce contract the settle() path relies on:
// waiting_to_submit -> waiting_for_batch -> (BatchFinalized) batch_succeeded,
// and that a succeeded intent no longer locks its VTXOs.
describe("settle intent persistence contract", () => {
    it("advances state from events and releases locked outpoints when terminal", async () => {
        const repo = new InMemoryIntentRepository();
        const base: ArkIntent = {
            intentTxId: "i1",
            state: "waiting_to_submit",
            createdAt: 1,
            updatedAt: 1,
            registerProof: "rp",
            registerProofMessage: "rpm",
            deleteProof: "dp",
            deleteProofMessage: "dpm",
            partialForfeits: [],
            intentVtxos: [{ txid: "v", vout: 0 }],
        };
        await repo.saveIntent(base);
        await repo.saveIntent({ ...base, state: "waiting_for_batch" });

        expect(await repo.getLockedVtxoOutpoints()).toEqual([{ txid: "v", vout: 0 }]);

        const cur = (await repo.getIntents({ intentTxIds: ["i1"] }))[0];
        const next = applySettlementEventToIntent(cur, {
            type: SettlementEventType.BatchFinalized,
            id: "batch-1",
            commitmentTxid: "ctx",
        } as never);
        expect(next).toBeDefined();
        if (next) await repo.saveIntent(next);

        const done = (await repo.getIntents({ intentTxIds: ["i1"] }))[0];
        expect(done.state).toBe("batch_succeeded");
        expect(done.commitmentTransactionId).toBe("ctx");
        expect(done.batchId).toBe("batch-1");
        expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
    });
});
