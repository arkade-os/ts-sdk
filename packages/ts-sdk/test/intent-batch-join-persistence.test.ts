import { describe, it, expect } from "vitest";
import { Batch } from "../src/wallet/batch";
import { wrapHandlerWithIntentPersistence } from "../src/wallet/intentPersistenceHandler";
import { InMemoryIntentRepository } from "../src/repositories/inMemory/intentRepository";
import type { ArkIntent } from "../src/repositories/intentRepository";
import { SettlementEventType, type SettlementEvent } from "../src/providers/ark";

// Batch.join drives persistence from the awaited handler hooks, so the outcome
// is recorded regardless of what the observational eventCallback does.

const intentTxId = "i1";

async function* streamOf(...events: SettlementEvent[]): AsyncIterableIterator<SettlementEvent> {
    yield* events;
}

const started: SettlementEvent = {
    type: SettlementEventType.BatchStarted,
    id: "batch-1",
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

function seededRepo(): InMemoryIntentRepository {
    const repo = new InMemoryIntentRepository();
    const intent: ArkIntent = {
        intentTxId,
        state: "waiting_for_batch",
        createdAt: 1,
        updatedAt: 1,
        registerProof: "rp",
        registerProofMessage: "rpm",
        deleteProof: "dp",
        deleteProofMessage: "dpm",
        partialForfeits: [],
        intentVtxos: [{ txid: "v", vout: 0 }],
    };
    void repo.saveIntent(intent);
    return repo;
}

const wrappedHandler = (repo: InMemoryIntentRepository) =>
    wrapHandlerWithIntentPersistence(
        {
            onBatchStarted: async () => ({ skip: false }),
            onTreeSigningStarted: async () => ({ skip: true }),
            onTreeNonces: async () => ({ fullySigned: true }),
            onBatchFinalization: async () => {},
        },
        { intentRepository: repo, intentTxId },
    );

const stateOf = (repo: InMemoryIntentRepository) =>
    repo.getIntents({ intentTxIds: [intentTxId] }).then((r) => r[0].state);

describe("Batch.join intent persistence", () => {
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
