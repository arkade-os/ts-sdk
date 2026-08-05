import { beforeEach, describe, expect, it } from "vitest";
import { addAssetSwap, getAssetSwaps, updateAssetSwap, AssetSwap } from "../src/store";
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

    it("never fails the caller when the backend cannot persist or read", async () => {
        const broken: AssetSwapRepository = {
            version: 1,
            saveSwap: async () => {
                throw new Error("quota exceeded");
            },
            getAllSwaps: async () => {
                throw new Error("backend gone");
            },
            getScannedTxids: async () => new Set(),
            markTxidsScanned: async () => {},
            getCachedMarkets: async () => undefined,
            saveCachedMarkets: async () => {},
            clear: async () => {},
            [Symbol.asyncDispose]: async () => {},
        };
        await expect(addAssetSwap(broken, swap("a"))).resolves.toEqual([swap("a")]);
        await expect(getAssetSwaps(broken)).resolves.toEqual([]);
        await expect(updateAssetSwap(broken, "a", { status: "cancelled" })).resolves.toEqual([]);
    });
});
