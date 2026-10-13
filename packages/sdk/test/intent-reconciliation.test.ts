import { collectIntents } from "../src/repositories/intentRepository";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { ContractManager } from "../src/contracts/contractManager";
import { InMemoryIntentRepository } from "../src/repositories/inMemory/intentRepository";
import {
    NO_MATCH_CONFIRM_FLOOR_MS,
    noMatchConfirmMs,
    reconcileIntents,
    releaseIntents,
    type IntentReconcilerIndexer,
} from "../src/wallet/intentReconciliation";
import type { ArkIntent, ArkIntentState } from "../src/repositories/intentRepository";
import type { VirtualCoin } from "../src/wallet";
import { ArkError } from "../src/providers/errors";

const intent = (over: Partial<ArkIntent>): ArkIntent => ({
    intentTxId: "i1",
    state: "waiting_for_batch",
    createdAt: 1,
    updatedAt: 1,
    registerProof: "rp",
    registerProofMessage: "rpm",
    deleteProof: "dp",
    deleteProofMessage: "dpm",
    partialForfeits: [],
    intentVtxos: [{ txid: "v", vout: 0 }],
    ...over,
});

// Minimal indexer VirtualCoin: only the fields the reconciler reads matter.
const coin = (txid: string, vout: number, over: Partial<VirtualCoin> = {}): VirtualCoin =>
    ({ txid, vout, isSpent: false, ...over }) as VirtualCoin;

const indexerReturning = (vtxos: VirtualCoin[]): IntentReconcilerIndexer => ({
    getVtxos: vi.fn().mockResolvedValue({ vtxos }),
});

const seed = async (repo: InMemoryIntentRepository, i: ArkIntent) => {
    await repo.saveIntent(i);
    return repo;
};

const stateOf = async (repo: InMemoryIntentRepository, id = "i1"): Promise<ArkIntentState> =>
    (await collectIntents(repo, { intentTxIds: [id] }))[0].state;

describe("reconcileIntents", () => {
    it("marks batch_succeeded when all inputs are consumed by a batch", async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            intent({ state: "waiting_for_batch" }),
        );
        const indexerProvider = indexerReturning([
            coin("v", 0, { isSpent: true, settledBy: "commitment-tx" }),
        ]);

        await reconcileIntents({ intentRepository: repo, indexerProvider });

        const done = (await collectIntents(repo, { intentTxIds: ["i1"] }))[0];
        expect(done.state).toBe("batch_succeeded");
        expect(done.commitmentTransactionId).toBe("commitment-tx");
        // Succeeded intent no longer locks its inputs.
        expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
    });

    it("preserves an existing commitment id when the input lacks settledBy", async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            intent({ state: "waiting_for_batch", commitmentTransactionId: "known-ctx" }),
        );
        const indexerProvider = indexerReturning([coin("v", 0, { isSpent: true })]);

        await reconcileIntents({ intentRepository: repo, indexerProvider });

        const done = (await collectIntents(repo, { intentTxIds: ["i1"] }))[0];
        expect(done.state).toBe("batch_succeeded");
        expect(done.commitmentTransactionId).toBe("known-ctx");
    });

    it("cancels a never-submitted intent whose inputs are still unspent", async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            intent({ state: "waiting_to_submit" }),
        );
        const indexerProvider = indexerReturning([coin("v", 0, { isSpent: false })]);

        await reconcileIntents({ intentRepository: repo, indexerProvider });

        const done = (await collectIntents(repo, { intentTxIds: ["i1"] }))[0];
        expect(done.state).toBe("cancelled");
        expect(done.cancellationReason).toMatch(/never submitted/i);
        expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
    });

    it("leaves an active server-held intent locked (unspent, submitted, not expired)", async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            intent({ state: "waiting_for_batch" }),
        );
        const indexerProvider = indexerReturning([coin("v", 0, { isSpent: false })]);

        await reconcileIntents({ intentRepository: repo, indexerProvider });

        expect(await stateOf(repo)).toBe("waiting_for_batch");
        // Inputs remain hidden from spendable balance.
        expect(await repo.getLockedVtxoOutpoints()).toEqual([{ txid: "v", vout: 0 }]);
    });

    it("cancels an expired intent whose inputs are still unspent", async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            intent({ state: "waiting_for_batch", validUntil: 500 }),
        );
        const indexerProvider = indexerReturning([coin("v", 0, { isSpent: false })]);

        await reconcileIntents({
            intentRepository: repo,
            indexerProvider,
            now: () => 1000,
        });

        const done = (await collectIntents(repo, { intentTxIds: ["i1"] }))[0];
        expect(done.state).toBe("cancelled");
        expect(done.cancellationReason).toMatch(/expired/i);
    });

    it("does not touch terminal intents (never fetched from the store)", async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            intent({ state: "batch_succeeded", commitmentTransactionId: "ctx" }),
        );
        const getVtxos = vi.fn().mockResolvedValue({ vtxos: [] });

        await reconcileIntents({ intentRepository: repo, indexerProvider: { getVtxos } });

        expect(getVtxos).not.toHaveBeenCalled();
        expect(await stateOf(repo)).toBe("batch_succeeded");
    });

    it("is a no-op (no throw) reported as incomplete when the indexer read fails", async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            intent({ state: "waiting_for_batch" }),
        );
        const indexerProvider: IntentReconcilerIndexer = {
            getVtxos: vi.fn().mockRejectedValue(new Error("indexer down")),
        };

        await expect(
            reconcileIntents({ intentRepository: repo, indexerProvider }),
        ).resolves.toEqual({ incomplete: true });
        // Untouched, so still locked.
        expect(await stateOf(repo)).toBe("waiting_for_batch");
    });

    it("is a no-op (no throw) reported as incomplete when the intent store read fails", async () => {
        const repo = new InMemoryIntentRepository();
        vi.spyOn(repo, "getIntentsPage").mockRejectedValueOnce(new Error("db corrupt"));
        const getVtxos = vi.fn();

        await expect(
            reconcileIntents({ intentRepository: repo, indexerProvider: { getVtxos } }),
        ).resolves.toEqual({ incomplete: true });
        expect(getVtxos).not.toHaveBeenCalled();
    });

    it("reconciles a mixed batch in one pass with a single indexer round-trip", async () => {
        const repo = new InMemoryIntentRepository();
        await repo.saveIntent(
            intent({
                intentTxId: "done",
                state: "waiting_for_batch",
                intentVtxos: [{ txid: "a", vout: 0 }],
            }),
        );
        await repo.saveIntent(
            intent({
                intentTxId: "stale",
                state: "waiting_to_submit",
                intentVtxos: [{ txid: "b", vout: 0 }],
            }),
        );
        await repo.saveIntent(
            intent({
                intentTxId: "live",
                state: "waiting_for_batch",
                intentVtxos: [{ txid: "c", vout: 0 }],
            }),
        );
        const getVtxos = vi.fn().mockResolvedValue({
            vtxos: [
                coin("a", 0, { isSpent: true, settledBy: "ctx" }),
                coin("b", 0, { isSpent: false }),
                coin("c", 0, { isSpent: false }),
            ],
        });

        await reconcileIntents({ intentRepository: repo, indexerProvider: { getVtxos } });

        expect(getVtxos).toHaveBeenCalledTimes(1);
        expect(await stateOf(repo, "done")).toBe("batch_succeeded");
        expect(await stateOf(repo, "stale")).toBe("cancelled");
        expect(await stateOf(repo, "live")).toBe("waiting_for_batch");
    });

    it("cancels a submitted, unexpired intent whose input was unilaterally exited", async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            intent({ state: "waiting_for_batch" }),
        );
        // The wire shape of an exit: onchain now, but never consumed offchain.
        const indexerProvider = indexerReturning([coin("v", 0, { isUnrolled: true })]);

        await reconcileIntents({ intentRepository: repo, indexerProvider });

        const done = (await collectIntents(repo, { intentTxIds: ["i1"] }))[0];
        expect(done.state).toBe("cancelled");
        expect(done.cancellationReason).toMatch(/unilaterally exited/i);
        // The whole point: without the exit branch these stay locked forever.
        expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
    });

    it("reports batch_succeeded when an input both settled and unrolled", async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            intent({ state: "waiting_for_batch" }),
        );
        const indexerProvider = indexerReturning([
            coin("v", 0, { settledBy: "commitment-tx", isUnrolled: true }),
        ]);

        await reconcileIntents({ intentRepository: repo, indexerProvider });

        const done = (await collectIntents(repo, { intentTxIds: ["i1"] }))[0];
        expect(done.state).toBe("batch_succeeded");
        expect(done.commitmentTransactionId).toBe("commitment-tx");
    });

    it("treats a spentBy-only input as consumed", async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            intent({
                state: "waiting_for_batch",
                intentVtxos: [
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

        await reconcileIntents({ intentRepository: repo, indexerProvider });

        const done = (await collectIntents(repo, { intentTxIds: ["i1"] }))[0];
        expect(done.state).toBe("batch_succeeded");
        expect(done.commitmentTransactionId).toBeUndefined();
        expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
    });

    it("does not treat an empty settledBy as consumed", async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            intent({ state: "waiting_for_batch" }),
        );
        // "" is the wire convention for "unset", not a commitment txid.
        const indexerProvider = indexerReturning([coin("v", 0, { settledBy: "" })]);

        await reconcileIntents({ intentRepository: repo, indexerProvider });

        const done = (await collectIntents(repo, { intentTxIds: ["i1"] }))[0];
        expect(done.state).toBe("waiting_for_batch");
        expect(done.commitmentTransactionId).toBeUndefined();
        expect(await repo.getLockedVtxoOutpoints()).toEqual([{ txid: "v", vout: 0 }]);
    });
});

describe("reconcileIntents: releasing stale intents from the server", () => {
    const deleteMessage = { type: "delete", expire_at: 0 } as const;
    const stale = (over: Partial<ArkIntent> = {}) =>
        intent({ deleteProofMessage: JSON.stringify(deleteMessage), ...over });
    const unspent = () => indexerReturning([coin("v", 0, { isSpent: false })]);
    const noMatch = () =>
        new ArkError(23, "no matching intents found for intent proof", "INVALID_INTENT_PROOF");

    it("deletes a submitted intent left by a dead process and cancels it", async () => {
        const repo = await seed(new InMemoryIntentRepository(), stale());
        const deleteIntent = vi.fn().mockResolvedValue(undefined);

        await reconcileIntents({
            intentRepository: repo,
            indexerProvider: unspent(),
            deleteIntent,
        });

        expect(deleteIntent).toHaveBeenCalledWith({ proof: "dp", message: deleteMessage });
        const done = (await collectIntents(repo, { intentTxIds: ["i1"] }))[0];
        expect(done.state).toBe("cancelled");
        expect(done.cancellationReason).toMatch(/released from the server/i);
        expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
    });

    describe('a "no matching intents" answer', () => {
        const T0 = 1_000_000;
        const gap = NO_MATCH_CONFIRM_FLOOR_MS;
        const pass = (
            repo: InMemoryIntentRepository,
            deleteIntent: ReturnType<typeof vi.fn>,
            at: number,
            indexerProvider: IntentReconcilerIndexer = unspent(),
        ) =>
            reconcileIntents({
                intentRepository: repo,
                indexerProvider,
                deleteIntent,
                now: () => at,
            });
        const only = async (repo: InMemoryIntentRepository) =>
            (await collectIntents(repo, { intentTxIds: ["i1"] }))[0];

        it("does not cancel on the first answer: stays locked and records noMatchSeenAt", async () => {
            const repo = await seed(new InMemoryIntentRepository(), stale());
            const deleteIntent = vi.fn().mockRejectedValue(noMatch());

            const result = await pass(repo, deleteIntent, T0);

            const after = await only(repo);
            expect(after.state).toBe("waiting_for_batch");
            expect(after.noMatchSeenAt).toBe(T0);
            expect(await repo.getLockedVtxoOutpoints()).toEqual([{ txid: "v", vout: 0 }]);
            expect(result.recheckAt).toBe(T0 + gap);
        });

        it("stays non-terminal on a second answer before the gap", async () => {
            const repo = await seed(new InMemoryIntentRepository(), stale());
            const deleteIntent = vi.fn().mockRejectedValue(noMatch());
            await pass(repo, deleteIntent, T0);

            const result = await pass(repo, deleteIntent, T0 + gap - 1);

            const after = await only(repo);
            expect(after.state).toBe("waiting_for_batch");
            expect(after.noMatchSeenAt).toBe(T0);
            expect(result.recheckAt).toBe(T0 + gap);
        });

        it("cancels on a second answer after the gap, from a fresh reconcile call", async () => {
            const repo = await seed(new InMemoryIntentRepository(), stale());
            const deleteIntent = vi.fn().mockRejectedValue(noMatch());
            await pass(repo, deleteIntent, T0);

            // A new call over the same repository stands in for a restart.
            await pass(repo, deleteIntent, T0 + gap);

            expect(await stateOf(repo)).toBe("cancelled");
            expect(await repo.getLockedVtxoOutpoints()).toEqual([]);
        });

        it("cancels when the next pass's delete succeeds (re-queued intent)", async () => {
            const repo = await seed(new InMemoryIntentRepository(), stale());
            await pass(repo, vi.fn().mockRejectedValue(noMatch()), T0);

            await pass(repo, vi.fn().mockResolvedValue(undefined), T0 + 1);

            expect(await stateOf(repo)).toBe("cancelled");
        });

        it("becomes batch_succeeded when the next pass finds the inputs spent", async () => {
            const repo = await seed(new InMemoryIntentRepository(), stale());
            const deleteIntent = vi.fn().mockRejectedValue(noMatch());
            await pass(repo, deleteIntent, T0);

            await pass(
                repo,
                deleteIntent,
                T0 + 1,
                indexerReturning([coin("v", 0, { isSpent: true, settledBy: "ctx" })]),
            );

            const after = await only(repo);
            expect(after.state).toBe("batch_succeeded");
            expect(after.commitmentTransactionId).toBe("ctx");
        });

        it("uses the configured gap and resolves it once per pass", async () => {
            const repo = new InMemoryIntentRepository();
            await repo.saveIntent(
                stale({ intentTxId: "a", intentVtxos: [{ txid: "va", vout: 0 }] }),
            );
            await repo.saveIntent(
                stale({ intentTxId: "b", intentVtxos: [{ txid: "vb", vout: 0 }] }),
            );
            const confirm = vi.fn().mockResolvedValue(10 * gap);

            const result = await reconcileIntents({
                intentRepository: repo,
                indexerProvider: indexerReturning([coin("va", 0), coin("vb", 0)]),
                deleteIntent: vi.fn().mockRejectedValue(noMatch()),
                noMatchConfirmMs: confirm,
                now: () => T0,
            });

            expect(confirm).toHaveBeenCalledTimes(1);
            expect(result.recheckAt).toBe(T0 + 10 * gap);
        });

        it("neither marks nor cancels when the gap cannot be resolved", async () => {
            const repo = await seed(new InMemoryIntentRepository(), stale());
            vi.spyOn(console, "warn").mockImplementation(() => {});

            await reconcileIntents({
                intentRepository: repo,
                indexerProvider: unspent(),
                deleteIntent: vi.fn().mockRejectedValue(noMatch()),
                noMatchConfirmMs: vi.fn().mockRejectedValue(new Error("getInfo down")),
                now: () => T0,
            });

            const after = await only(repo);
            expect(after.state).toBe("waiting_for_batch");
            expect(after.noMatchSeenAt).toBeUndefined();
        });
    });

    describe("noMatchConfirmMs", () => {
        it("falls back to the 2-minute floor for a missing sessionDuration", () => {
            expect(noMatchConfirmMs(0)).toBe(120_000);
        });
        it("is twice sessionDuration once that exceeds the floor", () => {
            expect(noMatchConfirmMs(600)).toBe(1_200_000);
        });
    });

    it("keeps the intent locked when the delete fails for another reason", async () => {
        const repo = await seed(new InMemoryIntentRepository(), stale());
        const deleteIntent = vi.fn().mockRejectedValue(new Error("network down"));

        await reconcileIntents({
            intentRepository: repo,
            indexerProvider: unspent(),
            deleteIntent,
        });

        expect(await stateOf(repo)).toBe("waiting_for_batch");
        expect(await repo.getLockedVtxoOutpoints()).toEqual([{ txid: "v", vout: 0 }]);
    });

    it("keeps the intent locked on INVALID_INTENT_PROOF with another message", async () => {
        const repo = await seed(new InMemoryIntentRepository(), stale());
        const deleteIntent = vi
            .fn()
            .mockRejectedValue(new ArkError(23, "invalid intent proof", "INVALID_INTENT_PROOF"));

        await reconcileIntents({
            intentRepository: repo,
            indexerProvider: unspent(),
            deleteIntent,
        });

        expect(await stateOf(repo)).toBe("waiting_for_batch");
    });

    it("does not delete an intent whose batch already succeeded", async () => {
        const repo = await seed(new InMemoryIntentRepository(), stale());
        const deleteIntent = vi.fn();
        const indexerProvider = indexerReturning([
            coin("v", 0, { isSpent: true, settledBy: "ctx" }),
        ]);

        await reconcileIntents({ intentRepository: repo, indexerProvider, deleteIntent });

        expect(deleteIntent).not.toHaveBeenCalled();
        expect(await stateOf(repo)).toBe("batch_succeeded");
    });

    it.each<ArkIntentState>(["waiting_to_submit", "waiting_for_batch", "batch_in_progress"])(
        "leaves a %s intent with an in-flight input to its live settle",
        async (state) => {
            const repo = await seed(new InMemoryIntentRepository(), stale({ state }));
            const deleteIntent = vi.fn().mockRejectedValue(noMatch());

            await reconcileIntents({
                intentRepository: repo,
                indexerProvider: unspent(),
                deleteIntent,
                isOutpointInFlight: (o) => o.txid === "v" && o.vout === 0,
            });

            expect(deleteIntent).not.toHaveBeenCalled();
            expect(await stateOf(repo)).toBe(state);
        },
    );

    it("does not delete a stale intent sharing an input with a live settle", async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            stale({
                intentVtxos: [
                    { txid: "v", vout: 0 },
                    { txid: "w", vout: 0 },
                ],
            }),
        );
        const deleteIntent = vi.fn();

        await reconcileIntents({
            intentRepository: repo,
            indexerProvider: indexerReturning([coin("v", 0), coin("w", 0)]),
            deleteIntent,
            isOutpointInFlight: (o) => o.txid === "w",
        });

        expect(deleteIntent).not.toHaveBeenCalled();
        expect(await stateOf(repo)).toBe("waiting_for_batch");
    });
});

describe("releaseIntents", () => {
    const pending = (over: Partial<ArkIntent> = {}) =>
        intent({ deleteProofMessage: JSON.stringify({ type: "delete", expire_at: 0 }), ...over });

    it("is true when every non-terminal intent is deleted, skipping terminal ones", async () => {
        const repo = new InMemoryIntentRepository();
        await repo.saveIntent(pending());
        await repo.saveIntent(pending({ intentTxId: "done", state: "batch_succeeded" }));
        const deleteIntent = vi.fn().mockResolvedValue(undefined);

        expect(await releaseIntents({ intentRepository: repo, deleteIntent })).toBe(true);
        expect(deleteIntent).toHaveBeenCalledTimes(1);
    });

    it("is true when the server no longer holds the intent", async () => {
        const repo = await seed(new InMemoryIntentRepository(), pending());
        const deleteIntent = vi
            .fn()
            .mockRejectedValue(
                new ArkError(
                    23,
                    "no matching intents found for intent proof",
                    "INVALID_INTENT_PROOF",
                ),
            );

        expect(await releaseIntents({ intentRepository: repo, deleteIntent })).toBe(true);
    });

    it("is false when a delete fails", async () => {
        const repo = await seed(new InMemoryIntentRepository(), pending());
        const deleteIntent = vi.fn().mockRejectedValue(new Error("network down"));

        expect(await releaseIntents({ intentRepository: repo, deleteIntent })).toBe(false);
    });

    it("is false for an intent a live settle owns", async () => {
        const repo = await seed(new InMemoryIntentRepository(), pending());
        const deleteIntent = vi.fn();

        expect(
            await releaseIntents({
                intentRepository: repo,
                deleteIntent,
                isOutpointInFlight: () => true,
            }),
        ).toBe(false);
        expect(deleteIntent).not.toHaveBeenCalled();
    });

    it("without deleteIntent, is true only when nothing is pending", async () => {
        const empty = await seed(new InMemoryIntentRepository(), pending({ state: "cancelled" }));
        expect(await releaseIntents({ intentRepository: empty })).toBe(true);

        const held = await seed(new InMemoryIntentRepository(), pending());
        expect(await releaseIntents({ intentRepository: held })).toBe(false);
    });
});

describe("ContractManager: re-checking a pending no-match confirmation", () => {
    const deleteMessage = { type: "delete", expire_at: 0 } as const;
    const noMatch = () =>
        new ArkError(23, "no matching intents found for intent proof", "INVALID_INTENT_PROOF");

    beforeEach(() => {
        // setImmediate stays real so advance() can let a timer's async pass run to the end.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const advance = async (ms: number) => {
        vi.advanceTimersByTime(ms);
        for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    };

    // Only the fields reconcileStaleIntents reads: a full create() would boot a watcher.
    const setup = async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            intent({ deleteProofMessage: JSON.stringify(deleteMessage) }),
        );
        const getVtxos = vi.fn().mockResolvedValue({ vtxos: [coin("v", 0)] });
        const manager: any = Object.create(ContractManager.prototype);
        manager.config = {
            intentRepository: repo,
            indexerProvider: { getVtxos },
            intentReconciliation: { deleteIntent: vi.fn().mockRejectedValue(noMatch()) },
        };
        await manager.reconcileStaleIntents(); // first answer: marks, arms the timer
        expect((await collectIntents(repo, { intentTxIds: ["i1"] }))[0].noMatchSeenAt).toBe(
            Date.now(),
        );
        return { repo, getVtxos, manager };
    };

    it("cancels on the timer's pass once the gap has passed", async () => {
        const { repo } = await setup();

        await advance(NO_MATCH_CONFIRM_FLOOR_MS);

        expect(await stateOf(repo)).toBe("cancelled");
    });

    it("retries after the floor when the timer's own pass fails", async () => {
        const { repo, getVtxos } = await setup();
        getVtxos.mockRejectedValueOnce(new Error("indexer down"));

        await advance(NO_MATCH_CONFIRM_FLOOR_MS);
        expect(await stateOf(repo)).toBe("waiting_for_batch");

        await advance(NO_MATCH_CONFIRM_FLOOR_MS);
        expect(await stateOf(repo)).toBe("cancelled");
    });

    it("keeps the armed timer when another pass fails before it is due", async () => {
        const { repo, getVtxos, manager } = await setup();
        getVtxos.mockRejectedValueOnce(new Error("indexer down"));

        await advance(NO_MATCH_CONFIRM_FLOOR_MS / 2);
        await manager.reconcileStaleIntents(); // e.g. a reconnect pass

        await advance(NO_MATCH_CONFIRM_FLOOR_MS / 2);
        expect(await stateOf(repo)).toBe("cancelled");
    });
});
