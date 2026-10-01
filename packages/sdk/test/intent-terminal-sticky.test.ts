import { describe, it, expect } from "vitest";
import { Wallet } from "../src/wallet/wallet";
import { InMemoryIntentRepository } from "../src/repositories/inMemory/intentRepository";
import type { ArkIntent, ArkIntentState } from "../src/repositories/intentRepository";

// persistIntentSnapshot is private; exercise the terminal-stickiness guard by
// invoking it against a minimal `this`. When the persisted intent is already
// terminal, a later settle-path error routing through the catch (which calls
// this with "cancelled") must NOT overwrite the recorded outcome.
type PersistFn = (
    intentTxId: string,
    state: ArkIntentState,
    intent: unknown,
    deleteIntent: unknown,
    inputs: unknown,
    patch?: Partial<ArkIntent>,
) => Promise<void>;

const persistIntentSnapshot = (Wallet.prototype as unknown as { persistIntentSnapshot: PersistFn })
    .persistIntentSnapshot;

const terminalIntent = (state: ArkIntentState): ArkIntent => ({
    intentTxId: "i1",
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
    intentVtxos: [{ txid: "v", vout: 0 }],
});

describe("persistIntentSnapshot terminal stickiness", () => {
    it("does not clobber a succeeded intent with a later 'cancelled'", async () => {
        const repo = new InMemoryIntentRepository();
        await repo.saveIntent(terminalIntent("batch_succeeded"));

        // Simulates settle()'s catch after Batch.join already succeeded.
        await persistIntentSnapshot.call(
            { intentRepository: repo },
            "i1",
            "cancelled",
            {},
            {},
            [],
            {
                cancellationReason: "updateDbAfterSettle threw",
            },
        );

        const got = (await repo.getIntents({ intentTxIds: ["i1"] }))[0];
        expect(got.state).toBe("batch_succeeded");
        expect(got.commitmentTransactionId).toBe("ctx");
        expect(got.cancellationReason).toBeUndefined();
    });

    it("does not clobber a failed intent either", async () => {
        const repo = new InMemoryIntentRepository();
        await repo.saveIntent(terminalIntent("batch_failed"));

        await persistIntentSnapshot.call({ intentRepository: repo }, "i1", "cancelled", {}, {}, []);

        expect((await repo.getIntents({ intentTxIds: ["i1"] }))[0].state).toBe("batch_failed");
    });

    it("is a no-op when no intent repository is configured", async () => {
        await expect(
            persistIntentSnapshot.call(
                { intentRepository: undefined },
                "i1",
                "cancelled",
                {},
                {},
                [],
            ),
        ).resolves.toBeUndefined();
    });
});
