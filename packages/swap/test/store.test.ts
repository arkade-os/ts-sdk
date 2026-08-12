import { beforeEach, describe, expect, it } from "vitest";
import {
    addAssetSwap,
    getAssetSwaps,
    updateAssetSwap,
    updateAssetSwapBestEffort,
    AssetSwap,
} from "../src/store";
import { AssetSwapRepository, InMemoryAssetSwapRepository } from "../src/repository";

const swap = (id: string): AssetSwap => ({
    id,
    fromAsset: "btc",
    toAsset: "f1".repeat(34),
    fromAmount: "10000",
    toAmount: "992",
    swapAddress: "tark1q...",
    swapPkScript: "5120" + "ab".repeat(32),
    offerHex: "0100",
    fundingTxid: id,
    status: "pending",
    createdAt: 1,
});

describe("asset swap store", () => {
    let repository: AssetSwapRepository;
    beforeEach(() => {
        repository = new InMemoryAssetSwapRepository();
    });

    it("adds swaps newest-first and dedups by id", async () => {
        // ordering is by createdAt alone (real records stamp Date.now() ms);
        // backends make no insertion-order promise for equal timestamps
        await addAssetSwap(repository, { ...swap("a"), createdAt: 1 });
        await addAssetSwap(repository, { ...swap("b"), createdAt: 2 });
        await addAssetSwap(repository, { ...swap("a"), createdAt: 3 });
        expect((await getAssetSwaps(repository)).map((s) => s.id)).toEqual(["b", "a"]);
        expect((await getAssetSwaps(repository)).find((s) => s.id === "a")?.createdAt).toBe(1);
    });

    it("returns swaps newest-first even when a restore scan inserted them out of order", async () => {
        // the restore scan rebuilds records in tx-scan order, so an older
        // completed swap can be added after a newer pending one — the prepend
        // alone would then bury the pending swap (and its Cancel button) at the
        // bottom of a swaps list
        await addAssetSwap(repository, { ...swap("newer-pending"), createdAt: 2_000 });
        await addAssetSwap(repository, {
            ...swap("older-completed"),
            status: "fulfilled",
            createdAt: 1_000,
        });
        expect((await getAssetSwaps(repository)).map((s) => s.id)).toEqual([
            "newer-pending",
            "older-completed",
        ]);
    });

    it("updates a swap by id", async () => {
        await addAssetSwap(repository, swap("a"));
        const swaps = await updateAssetSwap(repository, "a", {
            status: "fulfilled",
            spentTxid: "txid",
        });
        expect(swaps[0]).toMatchObject({ id: "a", status: "fulfilled", spentTxid: "txid" });
        expect((await getAssetSwaps(repository))[0]).toMatchObject({ status: "fulfilled" });
    });

    it("filters malformed records instead of surfacing them", async () => {
        await repository.saveSwap({ id: "broken" } as AssetSwap);
        await addAssetSwap(repository, swap("a"));
        expect((await getAssetSwaps(repository)).map((s) => s.id)).toEqual(["a"]);
    });

    it("reports failed add writes and keeps update writes best-effort", async () => {
        const broken = (existing: AssetSwap[] = []): AssetSwapRepository => ({
            version: 2,
            saveSwap: async () => {
                throw new Error("quota exceeded");
            },
            getAllSwaps: async () => existing,
            saveRfqSwap: async () => {},
            getAllRfqSwaps: async () => [],
            removeRfqSwap: async () => {},
            getScannedTxids: async () => new Set(),
            markTxidsScanned: async () => {},
            getCachedMarkets: async () => undefined,
            saveCachedMarkets: async () => {},
            clear: async () => {},
            [Symbol.asyncDispose]: async () => {},
        });

        // add gates funding: a lost pre-funding record must fail the caller
        await expect(addAssetSwap(broken(), swap("a"))).rejects.toThrow(
            /failed to save swap a: quota exceeded/,
        );
        // so does a gating update — cancelOffer's `cancelling` marker is
        // written before the broadcast it is there to explain
        await expect(
            updateAssetSwap(broken([swap("a")]), "a", { status: "cancelled" }),
        ).rejects.toThrow(/failed to save swap a: quota exceeded/);
        // the best-effort variant records what follows an irreversible action:
        // it must never throw after it, but must report the lost write
        await expect(
            updateAssetSwapBestEffort(broken([swap("a")]), "a", { status: "cancelled" }),
        ).resolves.toMatchObject({
            persisted: false,
            swaps: [{ id: "a", status: "cancelled" }],
        });
    });

    it("reads a failed read as empty history, but never writes on one", async () => {
        const broken: AssetSwapRepository = {
            version: 2,
            saveSwap: async () => {},
            getAllSwaps: async () => {
                throw new Error("backend gone");
            },
            saveRfqSwap: async () => {},
            getAllRfqSwaps: async () => [],
            removeRfqSwap: async () => {},
            getScannedTxids: async () => new Set(),
            markTxidsScanned: async () => {},
            getCachedMarkets: async () => undefined,
            saveCachedMarkets: async () => {},
            clear: async () => {},
            [Symbol.asyncDispose]: async () => {},
        };
        // a history view degrades to empty rather than crashing
        await expect(getAssetSwaps(broken)).resolves.toEqual([]);
        // but a mutation must not read "backend gone" as "no such swap" and
        // report success having written nothing
        await expect(updateAssetSwap(broken, "a", { status: "cancelled" })).rejects.toThrow(
            /backend gone/,
        );
        await expect(addAssetSwap(broken, swap("a"))).rejects.toThrow(/backend gone/);
        await expect(
            updateAssetSwapBestEffort(broken, "a", { status: "cancelled" }),
        ).resolves.toMatchObject({ persisted: false });
    });
});
