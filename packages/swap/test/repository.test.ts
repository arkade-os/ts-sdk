import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { AssetSwap } from "../src/store";
import { AssetSwapRepository, InMemoryAssetSwapRepository } from "../src/repository";
import { IndexedDbAssetSwapRepository } from "../src/indexedDbRepository";
import { runInTransaction, type SQLExecutor } from "@arkade-os/sdk/repositories/sqlite";
import { SQLiteAssetSwapRepository } from "../src/repositories/sqlite";
import { RealmAssetSwapRepository } from "../src/repositories/realm";
import { createNodeSQLExecutor } from "../../../config/test-helpers/nodeSqlExecutor";
import { createMockRealm } from "../../../config/test-helpers/mockRealm";
import { btcUsd } from "./fixtures";

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
    ["sqlite", () => new SQLiteAssetSwapRepository(createNodeSQLExecutor())],
    [
        "realm",
        () =>
            new RealmAssetSwapRepository(
                createMockRealm({
                    ArkadeAssetSwap: "id",
                    ArkadeAssetSwapScannedTxid: "txid",
                    ArkadeAssetSwapMarketsCache: "key",
                }),
            ),
    ],
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

    it("round-trips the swap secrets projection", async () => {
        await using repository = create();
        const secretive: AssetSwap = {
            ...swap("a"),
            signingDescriptor: "tr(02" + "cd".repeat(32) + ")",
            preimageHex: "11".repeat(32),
            preimageSaltHex: "22".repeat(32),
        };
        await repository.saveSwap(secretive);
        expect(await repository.getAllSwaps()).toEqual([secretive]);
    });

    it("keys the markets cache by network AND registry", async () => {
        await using repository = create();
        const entry = { markets: [btcUsd], fetchedAt: 1700 };
        await repository.saveCachedMarkets("regtest", REGISTRY, entry);
        expect(await repository.getCachedMarkets("regtest", REGISTRY)).toEqual(entry);
        expect(await repository.getCachedMarkets("mainnet", REGISTRY)).toBeUndefined();
        expect(
            await repository.getCachedMarkets("regtest", "https://other.example"),
        ).toBeUndefined();
    });

    // MIGRATION.md tells consumers to extend the record by cast, so a backend
    // that writes only the declared columns must fail here. The fixture is
    // JSON-safe on purpose: a Date or bigint would NOT round-trip equally
    // across backends, so asserting parity on one would assert something untrue.
    it("round-trips an unknown consumer field", async () => {
        await using repository = create();
        const quote = {
            feeBps: 30,
            pair: "BTC/USD",
            rate: { value: "0.0001", decimals: 6 },
            path: ["btc", "usd"],
        };
        const extended = { ...swap("a"), quote } as AssetSwap;
        await repository.saveSwap(extended);
        expect(await repository.getAllSwaps()).toEqual([extended]);
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

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
};

/** Same object identity in and out — the write chain is keyed by it. */
const recording = (db: SQLExecutor, log: string[]): SQLExecutor => ({
    run: (sql, params) => (log.push(sql), db.run(sql, params)),
    get: (sql, params) => (log.push(sql), db.get(sql, params)),
    all: (sql, params) => (log.push(sql), db.all(sql, params)),
});

describe("SQLiteAssetSwapRepository", () => {
    // Pins the every-write-goes-through-the-chain rule, by construction rather
    // than by racing: the gate resolves inside runInTransaction's callback,
    // which it invokes only after BEGIN IMMEDIATE.
    it("queues a single-statement write behind a neighbour's open transaction", async () => {
        const log: string[] = [];
        const db = recording(createNodeSQLExecutor(), log);
        await using repository = new SQLiteAssetSwapRepository(db);
        await repository.getAllSwaps(); // force ensureInit BEFORE the gate

        const inTx = deferred<void>();
        const release = deferred<void>();
        const neighbour = runInTransaction(db, async () => {
            inTx.resolve();
            await release.promise;
            throw new Error("neighbour fails");
        });

        await inTx.promise; // the transaction is now provably open

        // Control: a raw statement issued here joins the neighbour's
        // transaction and dies with it. This is the hazard the wrapping exists
        // to prevent — it tests SQLite, not our code.
        await db.run(
            `INSERT INTO arkade_asset_swaps (id, status, created_at, data)
             VALUES ('raw', 'pending', 1, '{"id":"raw"}')`,
        );

        const write = repository.saveSwap(swap("a")); // queues — do NOT await yet
        release.resolve();

        await expect(neighbour).rejects.toThrow("neighbour fails");
        await write;

        expect((await repository.getAllSwaps()).map((s) => s.id)).toEqual(["a"]);

        // Survival alone would still pass if the write had landed before the
        // gate; the ordering is what proves it queued.
        const rollbackAt = log.indexOf("ROLLBACK");
        const insertAt = log.findIndex((s) =>
            s.includes("INSERT OR REPLACE INTO arkade_asset_swaps"),
        );
        expect(rollbackAt).toBeGreaterThan(-1);
        expect(insertAt).toBeGreaterThan(rollbackAt);
    });

    it("isolates two prefixes on one connection", async () => {
        const db = createNodeSQLExecutor();
        await using app = new SQLiteAssetSwapRepository(db, { prefix: "app2_" });
        await using dflt = new SQLiteAssetSwapRepository(db);
        await app.saveSwap(swap("a"));
        expect((await app.getAllSwaps()).map((s) => s.id)).toEqual(["a"]);
        expect(await dflt.getAllSwaps()).toEqual([]);
    });

    it("rejects a prefix that is not a SQL identifier", () => {
        const db = createNodeSQLExecutor();
        expect(() => new SQLiteAssetSwapRepository(db, { prefix: "1_" })).toThrow(
            /Invalid table prefix/,
        );
        expect(() => new SQLiteAssetSwapRepository(db, { prefix: "a-b" })).toThrow(
            /Invalid table prefix/,
        );
    });
});
