import { collectBatchRegistrations } from "../src/repositories/batchRegistrationRepository";
import { describe, it, expect } from "vitest";
import { Batch } from "../src/wallet/batch";
import { wrapHandlerWithRegistrationPersistence } from "../src/wallet/batchRegistrationPersistenceHandler";
import { InMemoryBatchRegistrationRepository } from "../src/repositories/inMemory/batchRegistrationRepository";
import type { BatchRegistration } from "../src/repositories/batchRegistrationRepository";
import { SettlementEventType, type SettlementEvent } from "../src/providers/ark";

// Batch.join drives persistence from the awaited handler hooks, so the outcome
// is recorded regardless of what the observational eventCallback does.

const proofTxId = "i1";

async function* streamOf(...events: SettlementEvent[]): AsyncIterableIterator<SettlementEvent> {
    yield* events;
}

const started: SettlementEvent = {
    type: SettlementEventType.BatchStarted,
    id: "batch-1",
    registrationIdHashes: [],
    intentIdHashes: [],
    batchExpiry: 0n,
};
const finalization: SettlementEvent = {
    type: SettlementEventType.BatchFinalization,
    id: "batch-1",
    commitmentTx: "raw",
};
const finalized: SettlementEvent = {
    type: SettlementEventType.BatchFinalized,
    id: "batch-1",
    commitmentTxid: "ctx",
};
const failed: SettlementEvent = {
    type: SettlementEventType.BatchFailed,
    id: "batch-1",
    reason: "boom",
};

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

const wrappedHandler = (repo: InMemoryBatchRegistrationRepository) =>
    wrapHandlerWithRegistrationPersistence(
        {
            onBatchStarted: async () => ({ skip: false }),
            onTreeSigningStarted: async () => ({ skip: true }),
            onTreeNonces: async () => ({ fullySigned: true }),
            onBatchFinalization: async () => {},
        },
        { batchRegistrationRepository: repo, proofTxId },
    );

const stateOf = (repo: InMemoryBatchRegistrationRepository) =>
    collectBatchRegistrations(repo, { proofTxIds: [proofTxId] }).then((r) => r[0].state);

describe("Batch.join registration persistence", () => {
    it("persists batch_succeeded when the eventCallback throws", async () => {
        const repo = seededRepo();
        const txid = await Batch.join(
            streamOf(started, finalization, finalized),
            wrappedHandler(repo),
            {
                skipVtxoTreeSigning: true,
                eventCallback: async () => {
                    throw new Error("callback boom");
                },
            },
        );

        expect(txid).toBe("ctx");
        expect(await stateOf(repo)).toBe("batch_succeeded");
    });

    it("persists batch_succeeded when the eventCallback never resolves", async () => {
        const repo = seededRepo();
        const txid = await Batch.join(
            streamOf(started, finalization, finalized),
            wrappedHandler(repo),
            {
                skipVtxoTreeSigning: true,
                eventCallback: () => new Promise<void>(() => {}),
            },
        );

        expect(txid).toBe("ctx");
        expect(await stateOf(repo)).toBe("batch_succeeded");
    });

    it("persists batch_failed and rejects with the failure reason", async () => {
        const repo = seededRepo();
        await expect(
            Batch.join(streamOf(started, failed), wrappedHandler(repo), {
                skipVtxoTreeSigning: true,
            }),
        ).rejects.toThrow("boom");

        expect(await stateOf(repo)).toBe("batch_failed");
    });
});
