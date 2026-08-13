import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { AssetSwap } from "../src/store";
import type { RfqSwapRecord } from "../src/rfqRecord";
import { AssetSwapRepository, InMemoryAssetSwapRepository } from "../src/repository";
import { IndexedDbAssetSwapRepository } from "../src/indexedDbRepository";

const rfqRecord = (rfqId: string): RfqSwapRecord => ({
    rfqId,
    kind: "lightning_send",
    state: "pending",
    paymentHash: "d4".repeat(32),
    signingDescriptor: `tr(${"a7".repeat(32)})`,
    lockupAddress: "tark1qlockup",
    createdAt: 1,
    updatedAt: 1,
});

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

    it("clears both swaps and scan state", async () => {
        await using repository = create();
        await repository.saveSwap(swap("a"));
        await repository.markTxidsScanned(["t1"]);
        await repository.clear();
        expect(await repository.getAllSwaps()).toEqual([]);
        expect(await repository.getScannedTxids()).toEqual(new Set());
    });

    it("upserts rfq swaps by rfqId and returns them all", async () => {
        await using repository = create();
        await repository.saveRfqSwap(rfqRecord("r1"));
        await repository.saveRfqSwap(rfqRecord("r2"));
        await repository.saveRfqSwap({ ...rfqRecord("r1"), state: "settled" });
        const records = await repository.getAllRfqSwaps();
        expect(records).toHaveLength(2);
        expect(records.find((r) => r.rfqId === "r1")?.state).toBe("settled");
    });

    it("stores the record whole, down to the fields nothing else can recover", async () => {
        // The covenant lives in the contract row, but what is here is here
        // because nothing rebuilds it: `paymentHash` is one-way inside the
        // tree, `preimageHex` may be a swap's only claim secret, and
        // `expectedAmount` is the receive leg's value gate. A field-mapped
        // backend that dropped one would say nothing until a claim was due.
        await using repository = create();
        const record: RfqSwapRecord = {
            ...rfqRecord("r1"),
            kind: "lightning_receive",
            expectedAmount: 20_000,
            payoutAddress: "tark1qpayout",
            preimageHex: "ee".repeat(32),
        };
        await repository.saveRfqSwap(record);
        const [restored] = await repository.getAllRfqSwaps();
        expect(restored).toEqual(record);
    });

    it("removes an rfq swap by id and leaves the others", async () => {
        await using repository = create();
        await repository.saveRfqSwap(rfqRecord("r1"));
        await repository.saveRfqSwap(rfqRecord("r2"));
        await repository.removeRfqSwap("r1");
        expect((await repository.getAllRfqSwaps()).map((r) => r.rfqId)).toEqual(["r2"]);
    });

    it("keeps rfq swaps and asset swaps in separate stores", async () => {
        await using repository = create();
        await repository.saveSwap(swap("a"));
        await repository.saveRfqSwap(rfqRecord("a"));
        // same key, different kind of record: neither may shadow the other
        expect(await repository.getAllSwaps()).toHaveLength(1);
        expect(await repository.getAllRfqSwaps()).toHaveLength(1);
        expect((await repository.getAllSwaps())[0].id).toBe("a");
        expect((await repository.getAllRfqSwaps())[0].rfqId).toBe("a");
    });

    it("clears rfq swaps along with everything else", async () => {
        // A partial wipe is what the clear-all transaction exists to prevent.
        await using repository = create();
        await repository.saveRfqSwap(rfqRecord("r1"));
        await repository.saveSwap(swap("a"));
        await repository.markTxidsScanned(["t1"]);
        await repository.clear();
        expect(await repository.getAllRfqSwaps()).toEqual([]);
        expect(await repository.getAllSwaps()).toEqual([]);
        expect(await repository.getScannedTxids()).toEqual(new Set());
    });
});

/**
 * The riskiest claim in this change: the version bump runs against databases
 * that already hold real swaps. `initDatabase`'s contains-guard makes adding a
 * store idempotent, but only `onupgradeneeded` runs it, and that fires on a
 * version *increase* — so the bump is what makes the new store exist at all for
 * an existing user, and the existing stores must come through untouched.
 */
describe("IndexedDB v1 -> v2 migration", () => {
    it("adds the rfqSwaps store while keeping swaps, scan state and markets", async () => {
        const dbName = `migrate-${Math.random()}`;
        const markets = { markets: [], fetchedAt: 42 };

        // Seed a v1-shaped database: the three original stores, version 1.
        await new Promise<void>((resolve, reject) => {
            const open = indexedDB.open(dbName, 1);
            open.onupgradeneeded = () => {
                const db = open.result;
                db.createObjectStore("swaps", { keyPath: "id" });
                db.createObjectStore("scannedTxids");
                db.createObjectStore("markets");
            };
            open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction(["swaps", "scannedTxids", "markets"], "readwrite");
                tx.objectStore("swaps").put(swap("legacy"));
                tx.objectStore("scannedTxids").put("t1", "t1");
                tx.objectStore("markets").put(markets, "arkade-intents-markets-regtest-http://r");
                tx.oncomplete = () => {
                    db.close();
                    resolve();
                };
                tx.onerror = () => reject(tx.error);
            };
            open.onerror = () => reject(open.error);
        });

        // Open at v2 through the repository: onupgradeneeded must add only the
        // new store and leave the existing three alone.
        await using repository = new IndexedDbAssetSwapRepository(dbName);
        expect((await repository.getAllSwaps()).map((s) => s.id)).toEqual(["legacy"]);
        expect(await repository.getScannedTxids()).toEqual(new Set(["t1"]));
        expect(await repository.getCachedMarkets("regtest", "http://r")).toEqual(markets);
        expect(await repository.getAllRfqSwaps()).toEqual([]);

        // and the new store is usable immediately, not only after a reopen
        await repository.saveRfqSwap(rfqRecord("r1"));
        expect(await repository.getAllRfqSwaps()).toHaveLength(1);
    });
});
