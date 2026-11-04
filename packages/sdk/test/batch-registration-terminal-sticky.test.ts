import { collectBatchRegistrations } from "../src/repositories/batchRegistrationRepository";
import { describe, it, expect } from "vitest";
import { Wallet } from "../src/wallet/wallet";
import { InMemoryBatchRegistrationRepository } from "../src/repositories/inMemory/batchRegistrationRepository";
import type {
    BatchRegistration,
    BatchRegistrationState,
} from "../src/repositories/batchRegistrationRepository";

// persistIntentSnapshot is private; exercise the terminal-stickiness guard by
// invoking it against a minimal `this`. When the persisted intent is already
// terminal, a later settle-path error routing through the catch (which calls
// this with "cancelled") must NOT overwrite the recorded outcome.
type PersistFn = (
    proofTxId: string,
    state: BatchRegistrationState,
    intent: unknown,
    deleteRegistration: unknown,
    inputs: unknown,
    patch?: Partial<BatchRegistration>,
) => Promise<void>;

const persistRegistrationSnapshot = (
    Wallet.prototype as unknown as { persistRegistrationSnapshot: PersistFn }
).persistRegistrationSnapshot;

const terminalIntent = (state: BatchRegistrationState): BatchRegistration => ({
    proofTxId: "i1",
    state,
    createdAt: 1,
    updatedAt: 1,
    registerProof: "rp",
    registerProofMessage: "rpm",
    deleteProof: "dp",
    deleteProofMessage: "dpm",
    commitmentTransactionId: "ctx",
    batchId: "batch-1",
    partialForfeits: [],
    inputs: [{ txid: "v", vout: 0 }],
});

describe("persistIntentSnapshot terminal stickiness", () => {
    it("does not clobber a succeeded registration with a later 'cancelled'", async () => {
        const repo = new InMemoryBatchRegistrationRepository();
        await repo.saveRegistration(terminalIntent("batch_succeeded"));

        // Simulates settle()'s catch after Batch.join already succeeded.
        await persistRegistrationSnapshot.call(
            { batchRegistrationRepository: repo },
            "i1",
            "cancelled",
            {},
            {},
            [],
            {
                cancellationReason: "updateDbAfterSettle threw",
            },
        );

        const got = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        expect(got.state).toBe("batch_succeeded");
        expect(got.commitmentTransactionId).toBe("ctx");
        expect(got.cancellationReason).toBeUndefined();
    });

    it("does not clobber a failed registration either", async () => {
        const repo = new InMemoryBatchRegistrationRepository();
        await repo.saveRegistration(terminalIntent("batch_failed"));

        await persistRegistrationSnapshot.call(
            { batchRegistrationRepository: repo },
            "i1",
            "cancelled",
            {},
            {},
            [],
        );

        expect((await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0].state).toBe(
            "batch_failed",
        );
    });

    it("is a no-op when no batch registration repository is configured", async () => {
        await expect(
            persistRegistrationSnapshot.call(
                { batchRegistrationRepository: undefined },
                "i1",
                "cancelled",
                {},
                {},
                [],
            ),
        ).resolves.toBeUndefined();
    });
});
