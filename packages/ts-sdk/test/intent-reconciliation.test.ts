import { describe, it, expect, vi } from "vitest";
import { InMemoryIntentRepository } from "../src/repositories/inMemory/intentRepository";
import { reconcileIntents, type IntentReconcilerIndexer } from "../src/wallet/intentReconciliation";
import type { ArkIntent, ArkIntentState } from "../src/repositories/intentRepository";
import type { VirtualCoin } from "../src/wallet";

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
    (await repo.getIntents({ intentTxIds: [id] }))[0].state;

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

        const done = (await repo.getIntents({ intentTxIds: ["i1"] }))[0];
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

        const done = (await repo.getIntents({ intentTxIds: ["i1"] }))[0];
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

        const done = (await repo.getIntents({ intentTxIds: ["i1"] }))[0];
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

        const done = (await repo.getIntents({ intentTxIds: ["i1"] }))[0];
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

    it("is a no-op (no throw) when the indexer read fails", async () => {
        const repo = await seed(
            new InMemoryIntentRepository(),
            intent({ state: "waiting_for_batch" }),
        );
        const indexerProvider: IntentReconcilerIndexer = {
            getVtxos: vi.fn().mockRejectedValue(new Error("indexer down")),
        };

        await expect(
            reconcileIntents({ intentRepository: repo, indexerProvider }),
        ).resolves.toBeUndefined();
        // Untouched, so still locked.
        expect(await stateOf(repo)).toBe("waiting_for_batch");
    });

    it("is a no-op (no throw) when the intent store read fails", async () => {
        const repo = new InMemoryIntentRepository();
        vi.spyOn(repo, "getIntents").mockRejectedValueOnce(new Error("db corrupt"));
        const getVtxos = vi.fn();

        await expect(
            reconcileIntents({ intentRepository: repo, indexerProvider: { getVtxos } }),
        ).resolves.toBeUndefined();
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
});
