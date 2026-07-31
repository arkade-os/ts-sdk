import { beforeEach, describe, expect, it } from "vitest";
import { addAssetSwap, getAssetSwaps, updateAssetSwap, AssetSwap } from "../src/store";
import { memoryStorage } from "./memoryStorage";

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
    let storage: ReturnType<typeof memoryStorage>;
    beforeEach(() => {
        storage = memoryStorage();
    });

    it("adds swaps newest-first and dedups by id", () => {
        addAssetSwap(storage, swap("a"));
        addAssetSwap(storage, swap("b"));
        addAssetSwap(storage, swap("a"));
        expect(getAssetSwaps(storage).map((s) => s.id)).toEqual(["b", "a"]);
    });

    it("returns swaps newest-first even when a restore scan inserted them out of order", () => {
        // the restore scan rebuilds records in tx-scan order, so an older
        // completed swap can be added after a newer pending one — the prepend
        // alone would then bury the pending swap (and its Cancel button) at the
        // bottom of a swaps list
        addAssetSwap(storage, { ...swap("newer-pending"), createdAt: 2_000 });
        addAssetSwap(storage, {
            ...swap("older-completed"),
            status: "fulfilled",
            createdAt: 1_000,
        });
        expect(getAssetSwaps(storage).map((s) => s.id)).toEqual([
            "newer-pending",
            "older-completed",
        ]);
    });

    it("updates a swap by id", () => {
        addAssetSwap(storage, swap("a"));
        updateAssetSwap(storage, "a", { status: "fulfilled", spentTxid: "txid" });
        expect(getAssetSwaps(storage)[0]).toMatchObject({
            id: "a",
            status: "fulfilled",
            spentTxid: "txid",
        });
    });

    it("returns [] on empty or corrupt storage", () => {
        expect(getAssetSwaps(storage)).toEqual([]);
        storage.set("assetSwaps", "{not json");
        expect(getAssetSwaps(storage)).toEqual([]);
    });

    it("never fails the caller when the backend cannot persist", () => {
        const throwing = {
            get: () => null,
            set: () => {
                throw new Error("quota exceeded");
            },
        };
        expect(() => addAssetSwap(throwing, swap("a"))).not.toThrow();
    });
});
