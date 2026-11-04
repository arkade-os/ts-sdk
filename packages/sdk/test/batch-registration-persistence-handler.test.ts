import { collectBatchRegistrations } from "../src/repositories/batchRegistrationRepository";
import { describe, it, expect, vi } from "vitest";
import { wrapHandlerWithRegistrationPersistence } from "../src/wallet/batchRegistrationPersistenceHandler";
import { InMemoryBatchRegistrationRepository } from "../src/repositories/inMemory/batchRegistrationRepository";
import type { BatchRegistration } from "../src/repositories/batchRegistrationRepository";
import { Batch } from "../src/wallet/batch";
import {
    SettlementEventType,
    type BatchStartedEvent,
    type BatchFinalizedEvent,
    type BatchFailedEvent,
} from "../src/providers/ark";

const started: BatchStartedEvent = {
    type: SettlementEventType.BatchStarted,
    id: "batch-1",
    registrationIdHashes: [],
    intentIdHashes: [],
    batchExpiry: 0n,
};
const finalized: BatchFinalizedEvent = {
    type: SettlementEventType.BatchFinalized,
    id: "batch-1",
    commitmentTxid: "ctx",
};
const failed: BatchFailedEvent = {
    type: SettlementEventType.BatchFailed,
    id: "batch-1",
    reason: "boom",
};

const proofTxId = "i1";

function seededRepo(): InMemoryBatchRegistrationRepository {
    const repo = new InMemoryBatchRegistrationRepository();
    const intent: BatchRegistration = {
        proofTxId,
        state: "waiting_for_batch",
        createdAt: 1,
        updatedAt: 1,
        registerProof: "rp",
        registerProofMessage: "rpm",
        deleteProof: "dp",
        deleteProofMessage: "dpm",
        partialForfeits: [],
        inputs: [{ txid: "v", vout: 0 }],
    };
    void repo.saveRegistration(intent);
    return repo;
}

function baseHandler(overrides: Partial<Batch.Handler> = {}): Batch.Handler {
    return {
        onBatchStarted: async () => ({ skip: false }),
        onTreeSigningStarted: async () => ({ skip: true }),
        onTreeNonces: async () => ({ fullySigned: true }),
        onBatchFinalization: async () => {},
        ...overrides,
    };
}

const stateOf = (repo: InMemoryBatchRegistrationRepository) =>
    collectBatchRegistrations(repo, { proofTxIds: [proofTxId] }).then((r) => r[0]);

describe("wrapHandlerWithIntentPersistence", () => {
    it("advances to batch_in_progress on a started (non-skipped) batch", async () => {
        const repo = seededRepo();
        const base = baseHandler();
        const spy = vi.spyOn(base, "onBatchStarted");

        const result = await wrapHandlerWithRegistrationPersistence(base, {
            batchRegistrationRepository: repo,
            proofTxId,
        }).onBatchStarted(started);

        expect(result).toEqual({ skip: false });
        expect(spy).toHaveBeenCalledOnce();
        const got = await stateOf(repo);
        expect(got.state).toBe("batch_in_progress");
        expect(got.batchId).toBe("batch-1");
    });

    it("leaves state untouched when the base handler skips the batch", async () => {
        const repo = seededRepo();
        const wrapped = wrapHandlerWithRegistrationPersistence(
            baseHandler({ onBatchStarted: async () => ({ skip: true }) }),
            { batchRegistrationRepository: repo, proofTxId },
        );

        expect(await wrapped.onBatchStarted(started)).toEqual({ skip: true });
        expect((await stateOf(repo)).state).toBe("waiting_for_batch");
    });

    it("records batch_succeeded with the commitment id on finalized", async () => {
        const repo = seededRepo();
        const base = baseHandler({ onBatchFinalized: vi.fn(async () => {}) });

        await wrapHandlerWithRegistrationPersistence(base, {
            batchRegistrationRepository: repo,
            proofTxId,
        }).onBatchFinalized!(finalized);

        expect(base.onBatchFinalized).toHaveBeenCalledOnce();
        const got = await stateOf(repo);
        expect(got.state).toBe("batch_succeeded");
        expect(got.commitmentTransactionId).toBe("ctx");
    });

    it("records batch_failed and throws the reason when the base has no onBatchFailed", async () => {
        const repo = seededRepo();
        const wrapped = wrapHandlerWithRegistrationPersistence(baseHandler(), {
            batchRegistrationRepository: repo,
            proofTxId,
        });

        await expect(wrapped.onBatchFailed!(failed)).rejects.toThrow("boom");
        const got = await stateOf(repo);
        expect(got.state).toBe("batch_failed");
        expect(got.cancellationReason).toBe("boom");
    });

    it("records batch_failed but preserves a base onBatchFailed's handle-and-continue", async () => {
        const repo = seededRepo();
        const base = baseHandler({ onBatchFailed: vi.fn(async () => {}) });
        const wrapped = wrapHandlerWithRegistrationPersistence(base, {
            batchRegistrationRepository: repo,
            proofTxId,
        });

        await expect(wrapped.onBatchFailed!(failed)).resolves.toBeUndefined();
        expect(base.onBatchFailed).toHaveBeenCalledOnce();
        expect((await stateOf(repo)).state).toBe("batch_failed");
    });

    it("swallows a repo write failure on finalized (money flow unaffected)", async () => {
        const repo = {
            getRegistrationsPage: async () => ({
                items: [{ state: "waiting_for_batch" } as BatchRegistration],
            }),
            saveRegistration: async () => {
                throw new Error("db down");
            },
        };
        const wrapped = wrapHandlerWithRegistrationPersistence(baseHandler(), {
            batchRegistrationRepository: repo,
            proofTxId,
        });

        await expect(wrapped.onBatchFinalized!(finalized)).resolves.toBeUndefined();
    });

    it("still re-propagates the reason on failed when the repo write fails", async () => {
        const repo = {
            getRegistrationsPage: async () => ({
                items: [{ state: "waiting_for_batch" } as BatchRegistration],
            }),
            saveRegistration: async () => {
                throw new Error("db down");
            },
        };
        const wrapped = wrapHandlerWithRegistrationPersistence(baseHandler(), {
            batchRegistrationRepository: repo,
            proofTxId,
        });

        await expect(wrapped.onBatchFailed!(failed)).rejects.toThrow("boom");
    });

    it("delegates without persisting when no repository is configured", async () => {
        const base = baseHandler({ onBatchFinalized: vi.fn(async () => {}) });
        const wrapped = wrapHandlerWithRegistrationPersistence(base, { proofTxId });

        await expect(wrapped.onBatchFinalized!(finalized)).resolves.toBeUndefined();
        expect(base.onBatchFinalized).toHaveBeenCalledOnce();
    });
});
