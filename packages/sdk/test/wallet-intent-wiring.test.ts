import { collectBatchRegistrations } from "../src/repositories/intentRepository";
import { describe, it, expect } from "vitest";
import { InMemoryBatchRegistrationRepository } from "../src/repositories/inMemory/intentRepository";
import { applySettlementEventToIntent } from "../src/wallet/intentStateReducer";
import { SettlementEventType } from "../src/providers/ark";
import type {
    BatchRegistration,
    BatchRegistrationRepository,
} from "../src/repositories/intentRepository";
import { InMemoryContractRepository, InMemoryWalletRepository, SingleKey, Wallet } from "../src";

// Exercises the persist + event-reduce contract the settle() path relies on:
// waiting_to_submit -> waiting_for_batch -> (BatchFinalized) batch_succeeded,
// and that a succeeded intent no longer locks its VTXOs.
describe("settle intent persistence contract", () => {
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
            proofInputs: [{ txid: "v", vout: 0 }],
        };
        await repo.saveBatchRegistration(base);
        await repo.saveBatchRegistration({ ...base, state: "waiting_for_batch" });

        expect(await repo.getLockedVtxoOutpoints()).toEqual([{ txid: "v", vout: 0 }]);

        const cur = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        const next = applySettlementEventToIntent(cur, {
            type: SettlementEventType.BatchFinalized,
            id: "batch-1",
            commitmentTxid: "ctx",
        } as never);
        expect(next).toBeDefined();
        if (next) await repo.saveBatchRegistration(next);

        const done = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        expect(done.state).toBe("batch_succeeded");
        expect(done.commitmentTransactionId).toBe("ctx");
        expect(done.batchId).toBe("batch-1");
        expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
    });
});

describe("wallet setup", () => {
    it("rejects a repository that has only the old method names", async () => {
        const intentRepository = {
            saveIntent: async () => {},
            getIntentsPage: async () => ({ items: [] }),
        } as unknown as BatchRegistrationRepository;
        await expect(
            Wallet.create({
                identity: SingleKey.fromRandomBytes(),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                    intentRepository,
                },
            }),
        ).rejects.toThrow("`saveBatchRegistration`");
    });
});
