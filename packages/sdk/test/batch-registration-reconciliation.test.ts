import { collectBatchRegistrations } from "../src/repositories/batchRegistrationRepository";
import { describe, it, expect, vi } from "vitest";
import { InMemoryBatchRegistrationRepository } from "../src/repositories/inMemory/batchRegistrationRepository";
import {
    reconcileRegistrations,
    releaseRegistrations,
    type RegistrationReconcilerIndexer,
} from "../src/wallet/batchRegistrationReconciliation";
import type {
    BatchRegistration,
    BatchRegistrationState,
} from "../src/repositories/batchRegistrationRepository";
import type { VirtualCoin } from "../src/wallet";
import { ArkError } from "../src/providers/errors";

const intent = (over: Partial<BatchRegistration>): BatchRegistration => ({
    proofTxId: "i1",
    state: "waiting_for_batch",
    createdAt: 1,
    updatedAt: 1,
    registerProof: "rp",
    registerProofMessage: "rpm",
    deleteProof: "dp",
    deleteProofMessage: "dpm",
    partialForfeits: [],
    inputs: [{ txid: "v", vout: 0 }],
    ...over,
});

// Minimal indexer VirtualCoin: only the fields the reconciler reads matter.
const coin = (txid: string, vout: number, over: Partial<VirtualCoin> = {}): VirtualCoin =>
    ({ txid, vout, isSpent: false, ...over }) as VirtualCoin;

const indexerReturning = (vtxos: VirtualCoin[]): RegistrationReconcilerIndexer => ({
    getVtxos: vi.fn().mockResolvedValue({ vtxos }),
});

const seed = async (repo: InMemoryBatchRegistrationRepository, i: BatchRegistration) => {
    await repo.saveRegistration(i);
    return repo;
};

const stateOf = async (
    repo: InMemoryBatchRegistrationRepository,
    id = "i1",
): Promise<BatchRegistrationState> =>
    (await collectBatchRegistrations(repo, { proofTxIds: [id] }))[0].state;

describe("reconcileIntents", () => {
    it("marks batch_succeeded when all inputs are consumed by a batch", async () => {
        const repo = await seed(
            new InMemoryBatchRegistrationRepository(),
            intent({ state: "waiting_for_batch" }),
        );
        const indexerProvider = indexerReturning([
            coin("v", 0, { isSpent: true, settledBy: "commitment-tx" }),
        ]);

        await reconcileRegistrations({ batchRegistrationRepository: repo, indexerProvider });

        const done = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        expect(done.state).toBe("batch_succeeded");
        expect(done.commitmentTransactionId).toBe("commitment-tx");
        // Succeeded intent no longer locks its inputs.
        expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
    });

    it("preserves an existing commitment id when the input lacks settledBy", async () => {
        const repo = await seed(
            new InMemoryBatchRegistrationRepository(),
            intent({ state: "waiting_for_batch", commitmentTransactionId: "known-ctx" }),
        );
        const indexerProvider = indexerReturning([coin("v", 0, { isSpent: true })]);

        await reconcileRegistrations({ batchRegistrationRepository: repo, indexerProvider });

        const done = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        expect(done.state).toBe("batch_succeeded");
        expect(done.commitmentTransactionId).toBe("known-ctx");
    });

    it("keeps waiting_to_submit locked when registration acknowledgement may have been lost", async () => {
        const repo = await seed(
            new InMemoryBatchRegistrationRepository(),
            intent({ state: "waiting_to_submit" }),
        );
        const indexerProvider = indexerReturning([coin("v", 0, { isSpent: false })]);

        await reconcileRegistrations({ batchRegistrationRepository: repo, indexerProvider });

        const done = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        expect(done.state).toBe("waiting_to_submit");
        expect(done.cancellationReason).toBeUndefined();
        expect(await repo.getLockedVtxoOutpoints()).toEqual([{ txid: "v", vout: 0 }]);
    });

    it("leaves an active server-held registration locked (unspent, submitted, not expired)", async () => {
        const repo = await seed(
            new InMemoryBatchRegistrationRepository(),
            intent({ state: "waiting_for_batch" }),
        );
        const indexerProvider = indexerReturning([coin("v", 0, { isSpent: false })]);

        await reconcileRegistrations({ batchRegistrationRepository: repo, indexerProvider });

        expect(await stateOf(repo)).toBe("waiting_for_batch");
        // Inputs remain hidden from spendable balance.
        expect(await repo.getLockedVtxoOutpoints()).toEqual([{ txid: "v", vout: 0 }]);
    });

    it("cancels an expired registration whose inputs are still unspent", async () => {
        const repo = await seed(
            new InMemoryBatchRegistrationRepository(),
            intent({ state: "waiting_for_batch", validUntil: 500 }),
        );
        const indexerProvider = indexerReturning([coin("v", 0, { isSpent: false })]);

        await reconcileRegistrations({
            batchRegistrationRepository: repo,
            indexerProvider,
            now: () => 1000,
        });

        const done = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        expect(done.state).toBe("cancelled");
        expect(done.cancellationReason).toMatch(/expired/i);
    });

    it("does not touch terminal registrations (never fetched from the store)", async () => {
        const repo = await seed(
            new InMemoryBatchRegistrationRepository(),
            intent({ state: "batch_succeeded", commitmentTransactionId: "ctx" }),
        );
        const getVtxos = vi.fn().mockResolvedValue({ vtxos: [] });

        await reconcileRegistrations({
            batchRegistrationRepository: repo,
            indexerProvider: { getVtxos },
        });

        expect(getVtxos).not.toHaveBeenCalled();
        expect(await stateOf(repo)).toBe("batch_succeeded");
    });

    it("is a no-op (no throw) when the indexer read fails", async () => {
        const repo = await seed(
            new InMemoryBatchRegistrationRepository(),
            intent({ state: "waiting_for_batch" }),
        );
        const indexerProvider: RegistrationReconcilerIndexer = {
            getVtxos: vi.fn().mockRejectedValue(new Error("indexer down")),
        };

        await expect(
            reconcileRegistrations({ batchRegistrationRepository: repo, indexerProvider }),
        ).resolves.toBeUndefined();
        // Untouched, so still locked.
        expect(await stateOf(repo)).toBe("waiting_for_batch");
    });

    it("is a no-op (no throw) when the registration store read fails", async () => {
        const repo = new InMemoryBatchRegistrationRepository();
        vi.spyOn(repo, "getRegistrationsPage").mockRejectedValueOnce(new Error("db corrupt"));
        const getVtxos = vi.fn();

        await expect(
            reconcileRegistrations({
                batchRegistrationRepository: repo,
                indexerProvider: { getVtxos },
            }),
        ).resolves.toBeUndefined();
        expect(getVtxos).not.toHaveBeenCalled();
    });

    it("reconciles a mixed batch in one pass with a single indexer round-trip", async () => {
        const repo = new InMemoryBatchRegistrationRepository();
        await repo.saveRegistration(
            intent({
                proofTxId: "done",
                state: "waiting_for_batch",
                inputs: [{ txid: "a", vout: 0 }],
            }),
        );
        await repo.saveRegistration(
            intent({
                proofTxId: "stale",
                state: "waiting_to_submit",
                inputs: [{ txid: "b", vout: 0 }],
            }),
        );
        await repo.saveRegistration(
            intent({
                proofTxId: "live",
                state: "waiting_for_batch",
                inputs: [{ txid: "c", vout: 0 }],
            }),
        );
        const getVtxos = vi.fn().mockResolvedValue({
            vtxos: [
                coin("a", 0, { isSpent: true, settledBy: "ctx" }),
                coin("b", 0, { isSpent: false }),
                coin("c", 0, { isSpent: false }),
            ],
        });

        await reconcileRegistrations({
            batchRegistrationRepository: repo,
            indexerProvider: { getVtxos },
        });

        expect(getVtxos).toHaveBeenCalledTimes(1);
        expect(await stateOf(repo, "done")).toBe("batch_succeeded");
        expect(await stateOf(repo, "stale")).toBe("waiting_to_submit");
        expect(await stateOf(repo, "live")).toBe("waiting_for_batch");
    });

    it("cancels a submitted, unexpired registration whose input was unilaterally exited", async () => {
        const repo = await seed(
            new InMemoryBatchRegistrationRepository(),
            intent({ state: "waiting_for_batch" }),
        );
        // The wire shape of an exit: onchain now, but never consumed offchain.
        const indexerProvider = indexerReturning([coin("v", 0, { isUnrolled: true })]);

        await reconcileRegistrations({ batchRegistrationRepository: repo, indexerProvider });

        const done = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        expect(done.state).toBe("cancelled");
        expect(done.cancellationReason).toMatch(/unilaterally exited/i);
        // The whole point: without the exit branch these stay locked forever.
        expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
    });

    it("reports batch_succeeded when an input both settled and unrolled", async () => {
        const repo = await seed(
            new InMemoryBatchRegistrationRepository(),
            intent({ state: "waiting_for_batch" }),
        );
        const indexerProvider = indexerReturning([
            coin("v", 0, { settledBy: "commitment-tx", isUnrolled: true }),
        ]);

        await reconcileRegistrations({ batchRegistrationRepository: repo, indexerProvider });

        const done = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        expect(done.state).toBe("batch_succeeded");
        expect(done.commitmentTransactionId).toBe("commitment-tx");
    });

    it("treats a spentBy-only input as consumed", async () => {
        const repo = await seed(
            new InMemoryBatchRegistrationRepository(),
            intent({
                state: "waiting_for_batch",
                inputs: [
                    { txid: "v", vout: 0 },
                    { txid: "v", vout: 1 },
                ],
            }),
        );
        // No isSpent, no settledBy: the wire writes forfeited inputs this way.
        const indexerProvider = indexerReturning([
            coin("v", 0, { spentBy: "ark-tx" }),
            coin("v", 1, { spentBy: "ark-tx" }),
        ]);

        await reconcileRegistrations({ batchRegistrationRepository: repo, indexerProvider });

        const done = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        expect(done.state).toBe("batch_succeeded");
        expect(done.commitmentTransactionId).toBeUndefined();
        expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
    });

    it("does not treat an empty settledBy as consumed", async () => {
        const repo = await seed(
            new InMemoryBatchRegistrationRepository(),
            intent({ state: "waiting_for_batch" }),
        );
        // "" is the wire convention for "unset", not a commitment txid.
        const indexerProvider = indexerReturning([coin("v", 0, { settledBy: "" })]);

        await reconcileRegistrations({ batchRegistrationRepository: repo, indexerProvider });

        const done = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        expect(done.state).toBe("waiting_for_batch");
        expect(done.commitmentTransactionId).toBeUndefined();
        expect(await repo.getLockedVtxoOutpoints()).toEqual([{ txid: "v", vout: 0 }]);
    });
});

describe("reconcileIntents: releasing stale registrations from the server", () => {
    const deleteMessage = { type: "delete", expire_at: 0 } as const;
    const stale = (over: Partial<BatchRegistration> = {}) =>
        intent({ deleteProofMessage: JSON.stringify(deleteMessage), ...over });
    const unspent = () => indexerReturning([coin("v", 0, { isSpent: false })]);
    const noMatch = () =>
        new ArkError(23, "no matching intents found for intent proof", "INVALID_INTENT_PROOF");

    it("deletes a submitted registration left by a dead process and cancels it", async () => {
        const repo = await seed(new InMemoryBatchRegistrationRepository(), stale());
        const deleteRegistration = vi.fn().mockResolvedValue(undefined);

        await reconcileRegistrations({
            batchRegistrationRepository: repo,
            indexerProvider: unspent(),
            deleteRegistration,
        });

        expect(deleteRegistration).toHaveBeenCalledWith({ proof: "dp", message: deleteMessage });
        const done = (await collectBatchRegistrations(repo, { proofTxIds: ["i1"] }))[0];
        expect(done.state).toBe("cancelled");
        expect(done.cancellationReason).toMatch(/released from the server/i);
        expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
    });

    it("cancels when the server no longer holds the registration", async () => {
        const repo = await seed(new InMemoryBatchRegistrationRepository(), stale());
        const deleteRegistration = vi.fn().mockRejectedValue(noMatch());

        await reconcileRegistrations({
            batchRegistrationRepository: repo,
            indexerProvider: unspent(),
            deleteRegistration,
        });

        expect(await stateOf(repo)).toBe("cancelled");
    });

    it("releases a truly unsent waiting_to_submit row after the no-match response", async () => {
        const repo = await seed(
            new InMemoryBatchRegistrationRepository(),
            stale({ state: "waiting_to_submit" }),
        );
        const deleteRegistration = vi.fn().mockRejectedValue(noMatch());
        await reconcileRegistrations({
            batchRegistrationRepository: repo,
            indexerProvider: unspent(),
            deleteRegistration,
        });
        expect(deleteRegistration).toHaveBeenCalledWith({ proof: "dp", message: deleteMessage });
        expect(await stateOf(repo)).toBe("cancelled");
        expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
    });

    it("keeps the registration locked when the delete fails for another reason", async () => {
        const repo = await seed(new InMemoryBatchRegistrationRepository(), stale());
        const deleteRegistration = vi.fn().mockRejectedValue(new Error("network down"));

        await reconcileRegistrations({
            batchRegistrationRepository: repo,
            indexerProvider: unspent(),
            deleteRegistration,
        });

        expect(await stateOf(repo)).toBe("waiting_for_batch");
        expect(await repo.getLockedVtxoOutpoints()).toEqual([{ txid: "v", vout: 0 }]);
    });

    it("keeps the registration locked on INVALID_INTENT_PROOF with another message", async () => {
        const repo = await seed(new InMemoryBatchRegistrationRepository(), stale());
        const deleteRegistration = vi
            .fn()
            .mockRejectedValue(new ArkError(23, "invalid intent proof", "INVALID_INTENT_PROOF"));

        await reconcileRegistrations({
            batchRegistrationRepository: repo,
            indexerProvider: unspent(),
            deleteRegistration,
        });

        expect(await stateOf(repo)).toBe("waiting_for_batch");
    });

    it("does not delete a registration whose batch already succeeded", async () => {
        const repo = await seed(new InMemoryBatchRegistrationRepository(), stale());
        const deleteRegistration = vi.fn();
        const indexerProvider = indexerReturning([
            coin("v", 0, { isSpent: true, settledBy: "ctx" }),
        ]);

        await reconcileRegistrations({
            batchRegistrationRepository: repo,
            indexerProvider,
            deleteRegistration,
        });

        expect(deleteRegistration).not.toHaveBeenCalled();
        expect(await stateOf(repo)).toBe("batch_succeeded");
    });

    it.each<BatchRegistrationState>([
        "waiting_to_submit",
        "waiting_for_batch",
        "batch_in_progress",
    ])("leaves a %s intent with an in-flight input to its live settle", async (state) => {
        const repo = await seed(new InMemoryBatchRegistrationRepository(), stale({ state }));
        const deleteRegistration = vi.fn().mockRejectedValue(noMatch());

        await reconcileRegistrations({
            batchRegistrationRepository: repo,
            indexerProvider: unspent(),
            deleteRegistration,
            isOutpointInFlight: (o) => o.txid === "v" && o.vout === 0,
        });

        expect(deleteRegistration).not.toHaveBeenCalled();
        expect(await stateOf(repo)).toBe(state);
    });

    it("does not delete a stale registration sharing an input with a live settle", async () => {
        const repo = await seed(
            new InMemoryBatchRegistrationRepository(),
            stale({
                inputs: [
                    { txid: "v", vout: 0 },
                    { txid: "w", vout: 0 },
                ],
            }),
        );
        const deleteRegistration = vi.fn();

        await reconcileRegistrations({
            batchRegistrationRepository: repo,
            indexerProvider: indexerReturning([coin("v", 0), coin("w", 0)]),
            deleteRegistration,
            isOutpointInFlight: (o) => o.txid === "w",
        });

        expect(deleteRegistration).not.toHaveBeenCalled();
        expect(await stateOf(repo)).toBe("waiting_for_batch");
    });
});

describe("releaseIntents", () => {
    const pending = (over: Partial<BatchRegistration> = {}) =>
        intent({ deleteProofMessage: JSON.stringify({ type: "delete", expire_at: 0 }), ...over });

    it("is true when every non-terminal registration is deleted, skipping terminal ones", async () => {
        const repo = new InMemoryBatchRegistrationRepository();
        await repo.saveRegistration(pending());
        await repo.saveRegistration(pending({ proofTxId: "done", state: "batch_succeeded" }));
        const deleteRegistration = vi.fn().mockResolvedValue(undefined);

        expect(
            await releaseRegistrations({ batchRegistrationRepository: repo, deleteRegistration }),
        ).toBe(true);
        expect(deleteRegistration).toHaveBeenCalledTimes(1);
    });

    it("is true when the server no longer holds the registration", async () => {
        const repo = await seed(new InMemoryBatchRegistrationRepository(), pending());
        const deleteRegistration = vi
            .fn()
            .mockRejectedValue(
                new ArkError(
                    23,
                    "no matching intents found for intent proof",
                    "INVALID_INTENT_PROOF",
                ),
            );

        expect(
            await releaseRegistrations({ batchRegistrationRepository: repo, deleteRegistration }),
        ).toBe(true);
    });

    it("is false when a delete fails", async () => {
        const repo = await seed(new InMemoryBatchRegistrationRepository(), pending());
        const deleteRegistration = vi.fn().mockRejectedValue(new Error("network down"));

        expect(
            await releaseRegistrations({ batchRegistrationRepository: repo, deleteRegistration }),
        ).toBe(false);
    });

    it("is false for a registration a live settle owns", async () => {
        const repo = await seed(new InMemoryBatchRegistrationRepository(), pending());
        const deleteRegistration = vi.fn();

        expect(
            await releaseRegistrations({
                batchRegistrationRepository: repo,
                deleteRegistration,
                isOutpointInFlight: () => true,
            }),
        ).toBe(false);
        expect(deleteRegistration).not.toHaveBeenCalled();
    });

    it("without deleteIntent, is true only when nothing is pending", async () => {
        const empty = await seed(
            new InMemoryBatchRegistrationRepository(),
            pending({ state: "cancelled" }),
        );
        expect(await releaseRegistrations({ batchRegistrationRepository: empty })).toBe(true);

        const held = await seed(new InMemoryBatchRegistrationRepository(), pending());
        expect(await releaseRegistrations({ batchRegistrationRepository: held })).toBe(false);
    });
});
