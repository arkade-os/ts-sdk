import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { AssetSwap } from "../src/store";
import { AssetSwapRepository, InMemoryAssetSwapRepository } from "../src/repository";
import { IndexedDbAssetSwapRepository } from "../src/indexedDbRepository";

const swap = (id: string, createdAt = 1): AssetSwap => ({
    id,
    fromAsset: "btc",
    toAsset: "f1".repeat(34),
    fromAmount: "10000",
    toAmount: "992",
    swapAddress: "",
    swapPkScript: "5120" + "ab".repeat(32),
    offerHex: "0100",
    fundingTxid: id,
    status: "pending",
    createdAt,
});

const REGISTRY = "https://registry.example";

// one contract, every backend
const backends: [string, () => AssetSwapRepository][] = [
    ["inMemory", () => new InMemoryAssetSwapRepository()],
    // unique db name per run so fake-indexeddb state never leaks between tests
    ["indexedDb", () => new IndexedDbAssetSwapRepository(`test-${Math.random()}`)],
];

describe.each(backends)("AssetSwapRepository (%s)", (_, create) => {
    it("upserts by id and returns all swaps", async () => {
        await using repository = create();
        await repository.saveSwap(swap("a"));
        await repository.saveSwap(swap("b"));
        await repository.saveSwap({ ...swap("a"), status: "fulfilled" });
        const swaps = await repository.getAllSwaps();
        expect(swaps).toHaveLength(2);
        expect(swaps.find((s) => s.id === "a")?.status).toBe("fulfilled");
    });

    it("accumulates scanned txids across calls", async () => {
        await using repository = create();
        expect(await repository.getScannedTxids()).toEqual(new Set());
        await repository.markTxidsScanned(["t1", "t2"]);
        await repository.markTxidsScanned(["t2", "t3"]);
        expect(await repository.getScannedTxids()).toEqual(new Set(["t1", "t2", "t3"]));
    });

    // All three stores, because clear() is all-or-nothing across them and a
    // backend whose clear forgets one compiles and ships.
    it("clears swaps, scan state and the markets cache", async () => {
        await using repository = create();
        await repository.saveSwap(swap("a"));
        await repository.markTxidsScanned(["t1"]);
        await repository.saveCachedMarkets("regtest", REGISTRY, { markets: [], fetchedAt: 1 });
        await repository.clear();
        expect(await repository.getAllSwaps()).toEqual([]);
        expect(await repository.getScannedTxids()).toEqual(new Set());
        expect(await repository.getCachedMarkets("regtest", REGISTRY)).toBeUndefined();
    });
});
