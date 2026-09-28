import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { AssetSwap } from "../src/store";
import type { RfqSwapRecord } from "../src/rfqRecord";
import { AssetSwapRepository, InMemoryAssetSwapRepository } from "../src/repository";
import { IndexedDbAssetSwapRepository } from "../src/indexedDbRepository";
import { runInTransaction, type SQLExecutor } from "@arkade-os/sdk/repositories/sqlite";
import { SQLiteAssetSwapRepository } from "../src/repositories/sqlite";
import { RealmAssetSwapRepository } from "../src/repositories/realm";
import { createNodeSQLExecutor } from "../../../config/test-helpers/nodeSqlExecutor";
import { createMockRealm } from "../../../config/test-helpers/mockRealm";
import { btcUsd } from "./fixtures";

const rfqRecord = (rfqId: string): RfqSwapRecord => ({
    rfqId,
    kind: "lightning_send",
    state: "pending",
    lockupAddress: "tark1qlockup",
    // The corridor's own keys, nested — which is what a field-mapped backend is
    // likeliest to flatten or drop.
    profile: {
        signer: { signingDescriptor: `tr(${"a7".repeat(32)})` },
        hashlock: { paymentHash: "d4".repeat(32) },
    },
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
                    ArkadeRfqSwap: "rfqId",
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

    // A caching-forever ensureInit passes every other test in this file: the
    // first init succeeds there, so only a transient failure exposes it.
    it("retries init after a transient failure instead of caching the rejection", async () => {
        const db = createNodeSQLExecutor();
        let failNextDDL = true;
        const flaky: SQLExecutor = {
            run: (sql, params) => {
                if (failNextDDL && sql.includes("CREATE TABLE")) {
                    failNextDDL = false;
                    return Promise.reject(new Error("database is locked"));
                }
                return db.run(sql, params);
            },
            get: (sql, params) => db.get(sql, params),
            all: (sql, params) => db.all(sql, params),
        };
        await using repository = new SQLiteAssetSwapRepository(flaky);

        await expect(repository.getAllSwaps()).rejects.toThrow("database is locked");

        await repository.saveSwap(swap("a"));
        expect((await repository.getAllSwaps()).map((s) => s.id)).toEqual(["a"]);
    });

    it("isolates two prefixes on one connection", async () => {
        const db = createNodeSQLExecutor();
        await using app = new SQLiteAssetSwapRepository(db, { prefix: "app2_" });
        await using dflt = new SQLiteAssetSwapRepository(db);
        await app.saveSwap(swap("a"));
        await app.saveRfqSwap(rfqRecord("r1"));
        expect((await app.getAllSwaps()).map((s) => s.id)).toEqual(["a"]);
        expect(await dflt.getAllSwaps()).toEqual([]);
        // the rfq table is prefixed too — a hardcoded name would leak records
        // between two apps sharing one connection
        expect((await app.getAllRfqSwaps()).map((r) => r.rfqId)).toEqual(["r1"]);
        expect(await dflt.getAllRfqSwaps()).toEqual([]);
    });

    // The counterpart of the IndexedDB migration test below, and the same
    // riskiest-claim shape: the rfq table has to appear for a database that
    // predates it. Nothing here bumps a version, so `CREATE TABLE IF NOT EXISTS`
    // on every init is the entire mechanism — and this is what says so.
    it("adds the rfq table to a database that only has the original three", async () => {
        const db = createNodeSQLExecutor();
        // A pre-RFQ database, created the way the old init created it.
        await db.run(`CREATE TABLE arkade_asset_swaps (
            id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL
        )`);
        await db.run(`CREATE TABLE arkade_asset_swap_scanned_txids (txid TEXT PRIMARY KEY)`);
        await db.run(
            `CREATE TABLE arkade_asset_swap_markets (cache_key TEXT PRIMARY KEY, data TEXT NOT NULL)`,
        );
        await db.run(
            `INSERT INTO arkade_asset_swaps (id, status, created_at, data) VALUES (?, ?, ?, ?)`,
            ["legacy", "pending", 1, JSON.stringify(swap("legacy"))],
        );

        await using repository = new SQLiteAssetSwapRepository(db);
        await repository.saveRfqSwap(rfqRecord("r1"));
        expect((await repository.getAllRfqSwaps()).map((r) => r.rfqId)).toEqual(["r1"]);
        // and the rows that were already there are untouched
        expect((await repository.getAllSwaps()).map((s) => s.id)).toEqual(["legacy"]);
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

/** The RFQ half, over EVERY backend — which is the point of this matrix: all
 * four implement the same three methods, and a backend that stores a record
 * short a field fails here rather than at a claim. */
describe.each(backends)("RFQ swap records (%s)", (_, create) => {
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
        // because nothing rebuilds it: `paymentHash` is one-way inside the tree,
        // the preimage material may be a swap's only route back to P, and
        // `expectedAmount` is the receive leg's value gate. A field-mapped
        // backend that dropped one would say nothing until a claim was due — and
        // the ones under `profile.hashlock` are nested, so they are the likeliest
        // to be lost. `preimageSaltHex` is here rather than `preimageHex`
        // because it is the arm a static wallet actually gets.
        await using repository = create();
        const record: RfqSwapRecord = {
            ...rfqRecord("r1"),
            kind: "lightning_receive",
            profile: {
                signer: { signingDescriptor: `tr(${"a7".repeat(32)})` },
                hashlock: { paymentHash: "d4".repeat(32), preimageSaltHex: "ee".repeat(32) },
                expectedAmount: 20_000,
                payoutAddress: "tark1qpayout",
            },
        };
        await repository.saveRfqSwap(record);
        const [restored] = await repository.getAllRfqSwaps();
        expect(restored).toEqual(record);
    });

    it("reads one record by key, and reports a miss as undefined", async () => {
        await using repository = create();
        await repository.saveRfqSwap(rfqRecord("r1"));
        await repository.saveRfqSwap(rfqRecord("r2"));
        expect(await repository.getRfqSwap("r2")).toEqual(rfqRecord("r2"));
        // retention prunes terminal records, so a miss is ordinary
        expect(await repository.getRfqSwap("gone")).toBeUndefined();
    });

    it("carries the caller's funding txid through the round trip", async () => {
        await using repository = create();
        const record = { ...rfqRecord("r1"), fundingArkTxid: "f0".repeat(32) };
        await repository.saveRfqSwap(record);
        expect(await repository.getRfqSwap("r1")).toEqual(record);
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

/**
 * A connection that went away used to strand the repository: the manager closes
 * the database on `versionchange` and this class cached the closed handle, so
 * every later transaction threw `InvalidStateError` with no path back.
 *
 * Unreachable before the RFQ store, since the version never increased and
 * `versionchange` never fired. The first upgrade is what makes it reachable, and
 * there are two outcomes worth telling apart — recovery, and honest failure.
 */
describe("a repository whose connection went away", () => {
    /** fake-indexeddb dispatches events on the microtask queue. */
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    it("reopens after an external delete", async () => {
        const dbName = `reopen-${Math.random()}`;
        await using repository = new IndexedDbAssetSwapRepository(dbName);
        await repository.saveRfqSwap(rfqRecord("r1"));

        // an outside delete fires `versionchange`, and the manager closes on it
        await new Promise<void>((resolve, reject) => {
            const del = indexedDB.deleteDatabase(dbName);
            del.onsuccess = () => resolve();
            del.onerror = () => reject(del.error);
        });
        await flush();

        // the recreated database is empty but usable — the point being that the
        // repository opens one at all rather than reusing a closed handle
        await repository.saveRfqSwap(rfqRecord("r2"));
        expect((await repository.getAllRfqSwaps()).map((r) => r.rfqId)).toEqual(["r2"]);
    });

    it("fails honestly, and repeatably, when another tab upgraded past it", async () => {
        // Terminal by design: an older bundle has no business writing a newer
        // schema. What the fix converts is the diagnosis — `VersionError` names
        // the reload, where `InvalidStateError` implies a client bug — and that
        // every retry re-fails the same way instead of sticking.
        const dbName = `newer-${Math.random()}`;
        await using repository = new IndexedDbAssetSwapRepository(dbName);
        await repository.saveRfqSwap(rfqRecord("r1"));

        const newer = await new Promise<IDBDatabase>((resolve, reject) => {
            const open = indexedDB.open(dbName, 99);
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
        });
        await flush();
        try {
            for (const attempt of [1, 2]) {
                await expect(
                    repository.saveRfqSwap(rfqRecord(`r${attempt}`)),
                    `attempt ${attempt}`,
                ).rejects.toMatchObject({ name: "VersionError" });
            }
        } finally {
            newer.close();
        }
    });
});
