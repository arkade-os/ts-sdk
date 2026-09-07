import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssetSwap } from "../src/store";
import type { RfqSwapRecord } from "../src/rfqRecord";
import { IndexedDbAssetSwapRepository } from "../src/indexedDbRepository";

/**
 * WebKit's transaction lifetime: a transaction goes inactive the moment the
 * script that created it yields — BEFORE the microtask queue drains — so a
 * request issued after any `await`, even of an already-settled promise, throws
 * `TransactionInactiveError`. Chrome and Firefox deactivate at the end of the
 * microtask checkpoint instead, and so does fake-indexeddb. Emulated here:
 * every store a transaction hands out refuses requests once a microtask has
 * passed since the transaction was created.
 */
const REQUESTS = new Set([
    "add",
    "clear",
    "count",
    "delete",
    "get",
    "getAll",
    "getAllKeys",
    "getKey",
    "put",
]);
const originalTransaction = IDBDatabase.prototype.transaction;

function emulateWebKitTransactionLifetime() {
    IDBDatabase.prototype.transaction = function (
        this: IDBDatabase,
        ...args: Parameters<IDBDatabase["transaction"]>
    ) {
        const tx = originalTransaction.apply(this, args);
        let active = true;
        queueMicrotask(() => {
            active = false;
        });
        const objectStore = tx.objectStore.bind(tx);
        tx.objectStore = (name: string) =>
            new Proxy(objectStore(name), {
                get(target, prop) {
                    const value = Reflect.get(target, prop, target);
                    if (typeof value !== "function") return value;
                    return (...params: unknown[]) => {
                        if (!active && typeof prop === "string" && REQUESTS.has(prop)) {
                            throw new DOMException(
                                "Failed to execute request: the transaction is not active.",
                                "TransactionInactiveError",
                            );
                        }
                        return value.apply(target, params);
                    };
                },
            });
        return tx;
    };
}

const swap: AssetSwap = {
    id: "funding-txid",
    fromAsset: "btc",
    toAsset: "f1".repeat(34),
    fromAmount: "10000",
    toAmount: "992",
    swapAddress: "",
    swapPkScript: "5120" + "ab".repeat(32),
    offerHex: "0100",
    fundingTxid: "funding-txid",
    status: "pending",
    createdAt: 1,
};

const rfqSwap = {
    rfqId: "rfq-1",
    kind: "lightning_send",
    state: "pending",
    lockupAddress: "tark1qlockup",
    profile: {},
    createdAt: 1,
    updatedAt: 1,
} as RfqSwapRecord;

describe("IndexedDbAssetSwapRepository under WebKit's transaction lifetime", () => {
    let repository: IndexedDbAssetSwapRepository;

    beforeEach(() => {
        emulateWebKitTransactionLifetime();
        // unique db name per test so fake-indexeddb state never leaks between tests
        repository = new IndexedDbAssetSwapRepository(`webkit-${Math.random()}`);
    });

    afterEach(async () => {
        IDBDatabase.prototype.transaction = originalTransaction;
        await repository[Symbol.asyncDispose]();
    });

    it("reads back the swaps it wrote", async () => {
        await repository.saveSwap(swap);
        expect(await repository.getAllSwaps()).toEqual([swap]);
    });

    it("reads back rfq swap records by key and in bulk", async () => {
        await repository.saveRfqSwap(rfqSwap);
        expect(await repository.getRfqSwap("rfq-1")).toEqual(rfqSwap);
        expect(await repository.getRfqSwap("rfq-2")).toBeUndefined();
        expect(await repository.getAllRfqSwaps()).toEqual([rfqSwap]);
    });

    it("reads back the scanned txids", async () => {
        await repository.markTxidsScanned(["a", "b"]);
        expect(await repository.getScannedTxids()).toEqual(new Set(["a", "b"]));
    });

    it("reads back the markets cache", async () => {
        const entry = { markets: [], fetchedAt: 42 };
        await repository.saveCachedMarkets("bitcoin", "https://registry", entry);
        expect(await repository.getCachedMarkets("bitcoin", "https://registry")).toEqual(entry);
        expect(await repository.getCachedMarkets("bitcoin", "https://other")).toBeUndefined();
    });

    it("reads an empty store after clear", async () => {
        await repository.saveSwap(swap);
        await repository.clear();
        expect(await repository.getAllSwaps()).toEqual([]);
    });

    // Proves the emulation bites: a read that takes the store across an await
    // fails the way the repository's own reads used to.
    it("rejects a request issued after the creating tick", async () => {
        await repository.saveSwap(swap);
        const db = await (repository as any).ensureDb();
        const store = await Promise.resolve(
            db.transaction(["swaps"], "readonly").objectStore("swaps"),
        );
        expect(() => store.getAll()).toThrowError(
            expect.objectContaining({ name: "TransactionInactiveError" }),
        );
    });
});
