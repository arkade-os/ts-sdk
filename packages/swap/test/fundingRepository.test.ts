import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createMockRealm } from "../../../config/test-helpers/mockRealm";
import { createNodeSQLExecutor } from "../../../config/test-helpers/nodeSqlExecutor";
import { IndexedDbAssetSwapRepository } from "../src/indexedDbRepository";
import { InMemoryAssetSwapRepository, type AssetSwapRepository } from "../src/repository";
import { RealmAssetSwapRepository } from "../src/repositories/realm";
import { SQLiteAssetSwapRepository } from "../src/repositories/sqlite";
import type { AssetSwap } from "../src/store";
import { canInsertPreparedSwap } from "../src/fundingPersistence";

const ASSET_ID = "f1".repeat(34);
const SERVER_KEY = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const SCRIPT = `5120${"ab".repeat(32)}`;
const TXID_A = "11".repeat(32);
const TXID_B = "22".repeat(32);
const BOUND_TXID = "33".repeat(32);

const prepared = (id: string, txid = TXID_A): AssetSwap => ({
    id,
    fromAsset: "btc",
    toAsset: ASSET_ID,
    fromAmount: "10000",
    toAmount: "992",
    swapAddress: "tark1qprepared",
    swapPkScript: SCRIPT,
    offerHex: "0100",
    fundingTxid: "",
    status: "pending",
    createdAt: 1,
    signingDescriptor: `tr(${SERVER_KEY})`,
    preimageSaltHex: "44".repeat(32),
    fundingIntent: {
        version: 1,
        state: "prepared",
        inputs: [{ txid, vout: 0 }],
        serverPubkey: SERVER_KEY,
        arkServerUrl: "https://ark.example/",
        output: { script: SCRIPT, value: "10000" },
    },
    quote: { feeBps: 30 },
    carrier: { mode: "purchase", physicalSats: "330" },
});

const legacy = (id: string): AssetSwap => ({
    ...prepared(id),
    fundingTxid: id,
    fundingIntent: undefined,
});

const clone = <T>(value: T): T => structuredClone(value);

type CorruptHarness = {
    repository: AssetSwapRepository;
    seed(swap: AssetSwap): Promise<void>;
};

const putIndexedDbSwap = (dbName: string, swap: AssetSwap): Promise<void> =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open(dbName, 2);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("swaps", "readwrite");
            tx.objectStore("swaps").put(swap);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onabort = () => {
                db.close();
                reject(tx.error);
            };
        };
    });

const realm = () =>
    createMockRealm({
        ArkadeAssetSwap: "id",
        ArkadeRfqSwap: "rfqId",
        ArkadeAssetSwapScannedTxid: "txid",
        ArkadeAssetSwapMarketsCache: "key",
    });

const backends: [string, () => AssetSwapRepository][] = [
    ["inMemory", () => new InMemoryAssetSwapRepository()],
    ["indexedDb", () => new IndexedDbAssetSwapRepository(`funding-${Math.random()}`)],
    ["sqlite", () => new SQLiteAssetSwapRepository(createNodeSQLExecutor())],
    ["realm", () => new RealmAssetSwapRepository(realm())],
];

const corruptBackends: { name: string; open(): Promise<CorruptHarness> }[] = [
    {
        name: "inMemory",
        async open() {
            const repository = new InMemoryAssetSwapRepository();
            return {
                repository,
                async seed(swap) {
                    const alias = legacy(swap.id);
                    await repository.saveSwap(alias);
                    Object.assign(alias, clone(swap));
                },
            };
        },
    },
    {
        name: "indexedDb",
        async open() {
            const dbName = `funding-corrupt-${Math.random()}`;
            const repository = new IndexedDbAssetSwapRepository(dbName);
            return {
                repository,
                async seed(swap) {
                    await repository.saveSwap(legacy(swap.id));
                    await putIndexedDbSwap(dbName, swap);
                },
            };
        },
    },
    {
        name: "sqlite",
        async open() {
            const db = createNodeSQLExecutor();
            const repository = new SQLiteAssetSwapRepository(db);
            return {
                repository,
                async seed(swap) {
                    await repository.saveSwap(legacy(swap.id));
                    await db.run("UPDATE arkade_asset_swaps SET data = ? WHERE id = ?", [
                        JSON.stringify(swap),
                        swap.id,
                    ]);
                },
            };
        },
    },
    {
        name: "realm",
        async open() {
            const db = realm();
            const repository = new RealmAssetSwapRepository(db);
            return {
                repository,
                async seed(swap) {
                    db.write(() => {
                        db.create(
                            "ArkadeAssetSwap",
                            {
                                id: swap.id,
                                status: swap.status,
                                createdAt: swap.createdAt,
                                data: JSON.stringify(swap),
                            },
                            "modified",
                        );
                    });
                },
            };
        },
    },
];

describe.each(backends)("prepared funding repository (%s)", (_, create) => {
    it("inserts one validated prepared row and reads a snapshot", async () => {
        await using repository = create();
        const swap = prepared("operation-a");
        await expect(repository.insertPreparedSwap(swap)).resolves.toBe(true);
        expect(await repository.getSwap(swap.id)).toEqual(swap);
    });

    it("does not overwrite an existing id", async () => {
        await using repository = create();
        const first = prepared("operation-a");
        const second = { ...prepared("operation-a", TXID_B), createdAt: 2 };
        expect(await repository.insertPreparedSwap(first)).toBe(true);
        expect(await repository.insertPreparedSwap(second)).toBe(false);
        expect(await repository.getSwap(first.id)).toEqual(first);
    });

    it("atomically reserves inputs while prepared or submitted", async () => {
        await using repository = create();
        expect(await repository.insertPreparedSwap(prepared("operation-a"))).toBe(true);
        expect(await repository.insertPreparedSwap(prepared("operation-b"))).toBe(false);
        expect(await repository.insertPreparedSwap(prepared("operation-c", TXID_B))).toBe(true);
        expect(
            await repository.advanceFundingState("operation-a", "prepared", { state: "submitted" }),
        ).toBe(true);
        await repository.saveSwap({
            ...(await repository.getSwap("operation-a"))!,
            status: "cancelled",
        });
        expect(await repository.insertPreparedSwap(prepared("operation-d"))).toBe(false);
    });

    it("releases reservations only after bound or abandoned", async () => {
        await using repository = create();
        expect(await repository.insertPreparedSwap(prepared("operation-a"))).toBe(true);
        expect(
            await repository.advanceFundingState("operation-a", "prepared", { state: "abandoned" }),
        ).toBe(true);
        expect((await repository.getSwap("operation-a"))?.status).toBe("cancelled");
        expect(await repository.insertPreparedSwap(prepared("operation-b"))).toBe(true);
        expect(
            await repository.advanceFundingState("operation-b", "prepared", { state: "submitted" }),
        ).toBe(true);
        expect(
            await repository.advanceFundingState("operation-b", "submitted", {
                state: "bound",
                fundingTxid: BOUND_TXID,
            }),
        ).toBe(true);
        expect(await repository.insertPreparedSwap(prepared("operation-c"))).toBe(true);
    });

    it("enforces the funding-state transition graph and CAS", async () => {
        await using repository = create();
        await repository.insertPreparedSwap(prepared("operation-a"));
        expect(
            await repository.advanceFundingState("operation-a", "submitted", {
                state: "bound",
                fundingTxid: BOUND_TXID,
            }),
        ).toBe(false);
        expect(
            await repository.advanceFundingState("operation-a", "prepared", {
                state: "bound",
                fundingTxid: BOUND_TXID,
            }),
        ).toBe(false);
        expect(
            await repository.advanceFundingState("operation-a", "prepared", { state: "submitted" }),
        ).toBe(true);
        expect(
            await repository.advanceFundingState("operation-a", "submitted", {
                state: "abandoned",
            }),
        ).toBe(false);
        expect(
            await repository.advanceFundingState("operation-a", "submitted", {
                state: "bound",
                fundingTxid: BOUND_TXID,
            }),
        ).toBe(true);
        expect(
            await repository.advanceFundingState("operation-a", "submitted", {
                state: "bound",
                fundingTxid: BOUND_TXID,
            }),
        ).toBe(true);
        expect(
            await repository.advanceFundingState("operation-a", "submitted", {
                state: "bound",
                fundingTxid: "55".repeat(32),
            }),
        ).toBe(false);
    });

    it("rejects a non-string bound txid without releasing the inputs", async () => {
        await using repository = create();
        await repository.insertPreparedSwap(prepared("operation-a"));
        await repository.advanceFundingState("operation-a", "prepared", { state: "submitted" });
        await expect(
            repository.advanceFundingState("operation-a", "submitted", {
                state: "bound",
                fundingTxid: [BOUND_TXID],
            } as never),
        ).rejects.toThrow();
        expect((await repository.getSwap("operation-a"))?.fundingIntent?.state).toBe("submitted");
        expect(await repository.insertPreparedSwap(prepared("operation-b"))).toBe(false);
    });

    it("keeps abandoned rows terminal", async () => {
        await using repository = create();
        await repository.insertPreparedSwap(prepared("operation-a"));
        expect(
            await repository.advanceFundingState("operation-a", "prepared", { state: "abandoned" }),
        ).toBe(true);
        expect(
            await repository.advanceFundingState("operation-a", "prepared", { state: "submitted" }),
        ).toBe(false);
    });

    it("rejects generic preparation and legacy retrofit bypasses", async () => {
        await using repository = create();
        await expect(repository.saveSwap(prepared("operation-a"))).rejects.toThrow();
        await repository.saveSwap(legacy(BOUND_TXID));
        await expect(
            repository.saveSwap({ ...prepared(BOUND_TXID), fundingTxid: BOUND_TXID }),
        ).rejects.toThrow();
    });

    it("keeps submitted authority through an ordinary stale save", async () => {
        await using repository = create();
        await repository.insertPreparedSwap(prepared("operation-a"));
        const stale = (await repository.getSwap("operation-a"))!;
        await repository.advanceFundingState("operation-a", "prepared", { state: "submitted" });
        await repository.saveSwap({ ...stale, quote: { feeBps: 45 } } as AssetSwap);
        const stored = await repository.getSwap("operation-a");
        expect(stored?.fundingIntent?.state).toBe("submitted");
        expect((stored as AssetSwap & { quote: unknown }).quote).toEqual({ feeBps: 45 });
    });

    it("keeps bound authority and write-once txid through an ordinary stale save", async () => {
        await using repository = create();
        await repository.insertPreparedSwap(prepared("operation-a"));
        const stale = (await repository.getSwap("operation-a"))!;
        await repository.advanceFundingState("operation-a", "prepared", { state: "submitted" });
        await repository.advanceFundingState("operation-a", "submitted", {
            state: "bound",
            fundingTxid: BOUND_TXID,
        });
        await repository.saveSwap({ ...stale, quote: { feeBps: 45 } } as AssetSwap);
        const stored = await repository.getSwap("operation-a");
        expect(stored?.fundingIntent?.state).toBe("bound");
        expect(stored?.fundingTxid).toBe(BOUND_TXID);
        expect((stored as AssetSwap & { quote: unknown }).quote).toEqual({ feeBps: 45 });
        expect((stored as AssetSwap & { carrier: unknown }).carrier).toEqual({
            mode: "purchase",
            physicalSats: "330",
        });
        expect(stored?.preimageSaltHex).toBe("44".repeat(32));
    });

    it("does not let an intentless stale update erase funding authority", async () => {
        await using repository = create();
        await repository.insertPreparedSwap(prepared("operation-a"));
        const stale = clone((await repository.getSwap("operation-a"))!);
        delete stale.fundingIntent;
        await repository.advanceFundingState("operation-a", "prepared", { state: "submitted" });
        await repository.saveSwap({ ...stale, status: "cancelling" });
        expect((await repository.getSwap("operation-a"))?.fundingIntent?.state).toBe("submitted");
    });

    it("rejects forged immutable facts and funding txids", async () => {
        await using repository = create();
        await repository.insertPreparedSwap(prepared("operation-a"));
        const current = (await repository.getSwap("operation-a"))!;
        await expect(repository.saveSwap({ ...current, offerHex: "0200" })).rejects.toThrow();
        await expect(
            repository.saveSwap({ ...current, fundingTxid: "55".repeat(32) }),
        ).rejects.toThrow();
        await expect(
            repository.saveSwap({
                ...current,
                fundingIntent: {
                    ...current.fundingIntent!,
                    inputs: [{ txid: TXID_B, vout: 0 }],
                },
            }),
        ).rejects.toThrow();
    });

    it("stores and returns snapshots for prepared-family rows", async () => {
        await using repository = create();
        const original = prepared("operation-a");
        await repository.insertPreparedSwap(original);
        original.fundingIntent!.state = "abandoned";
        original.fundingIntent!.inputs[0].vout = 9;
        expect((await repository.getSwap("operation-a"))?.fundingIntent?.state).toBe("prepared");
        const read = (await repository.getSwap("operation-a"))!;
        read.fundingIntent!.state = "submitted";
        read.fundingIntent!.inputs[0].vout = 7;
        const reread = await repository.getSwap("operation-a");
        expect(reread?.fundingIntent?.state).toBe("prepared");
        expect(reread?.fundingIntent?.inputs[0].vout).toBe(0);
    });

    it("keeps legacy save and read behavior", async () => {
        await using repository = create();
        await repository.saveSwap(legacy(BOUND_TXID));
        await repository.saveSwap({ ...legacy(BOUND_TXID), status: "fulfilled" });
        expect(await repository.getSwap(BOUND_TXID)).toMatchObject({
            status: "fulfilled",
            fundingTxid: BOUND_TXID,
        });
    });

    it.each([
        ["empty id", (s: AssetSwap) => ({ ...s, id: "" })],
        [
            "initial submitted state",
            (s: AssetSwap) => ({
                ...s,
                fundingIntent: { ...s.fundingIntent!, state: "submitted" as const },
            }),
        ],
        ["initial txid", (s: AssetSwap) => ({ ...s, fundingTxid: BOUND_TXID })],
        [
            "empty inputs",
            (s: AssetSwap) => ({ ...s, fundingIntent: { ...s.fundingIntent!, inputs: [] } }),
        ],
        [
            "too many inputs",
            (s: AssetSwap) => ({
                ...s,
                fundingIntent: {
                    ...s.fundingIntent!,
                    inputs: Array.from({ length: 257 }, (_, i) => ({
                        txid: i.toString(16).padStart(64, "0"),
                        vout: 0,
                    })),
                },
            }),
        ],
        [
            "duplicate inputs",
            (s: AssetSwap) => ({
                ...s,
                fundingIntent: {
                    ...s.fundingIntent!,
                    inputs: [s.fundingIntent!.inputs[0], s.fundingIntent!.inputs[0]],
                },
            }),
        ],
        [
            "uppercase input txid",
            (s: AssetSwap) => ({
                ...s,
                fundingIntent: {
                    ...s.fundingIntent!,
                    inputs: [{ txid: "AA".repeat(32), vout: 0 }],
                },
            }),
        ],
        [
            "invalid vout",
            (s: AssetSwap) => ({
                ...s,
                fundingIntent: {
                    ...s.fundingIntent!,
                    inputs: [{ txid: TXID_A, vout: 0x1_0000_0000 }],
                },
            }),
        ],
        [
            "non-curve server key",
            (s: AssetSwap) => ({
                ...s,
                fundingIntent: { ...s.fundingIntent!, serverPubkey: "ff".repeat(32) },
            }),
        ],
        [
            "noncanonical URL",
            (s: AssetSwap) => ({
                ...s,
                fundingIntent: { ...s.fundingIntent!, arkServerUrl: "https://ark.example" },
            }),
        ],
        [
            "uppercase script",
            (s: AssetSwap) => ({
                ...s,
                fundingIntent: {
                    ...s.fundingIntent!,
                    output: { ...s.fundingIntent!.output, script: SCRIPT.toUpperCase() },
                },
            }),
        ],
        [
            "zero output value",
            (s: AssetSwap) => ({
                ...s,
                fundingIntent: {
                    ...s.fundingIntent!,
                    output: { ...s.fundingIntent!.output, value: "0" },
                },
            }),
        ],
        [
            "mismatched script",
            (s: AssetSwap) => ({
                ...s,
                fundingIntent: {
                    ...s.fundingIntent!,
                    output: { ...s.fundingIntent!.output, script: `5120${"cd".repeat(32)}` },
                },
            }),
        ],
        [
            "mismatched btc value",
            (s: AssetSwap) => ({
                ...s,
                fundingIntent: {
                    ...s.fundingIntent!,
                    output: { ...s.fundingIntent!.output, value: "9999" },
                },
            }),
        ],
        [
            "btc asset fields",
            (s: AssetSwap) => ({
                ...s,
                fundingIntent: {
                    ...s.fundingIntent!,
                    output: { ...s.fundingIntent!.output, assetId: ASSET_ID, assetAmount: "10000" },
                },
            }),
        ],
        [
            "unpaired asset fields",
            (s: AssetSwap) => ({
                ...s,
                fromAsset: ASSET_ID,
                fundingIntent: {
                    ...s.fundingIntent!,
                    output: { ...s.fundingIntent!.output, assetId: ASSET_ID },
                },
            }),
        ],
        [
            "zero from amount",
            (s: AssetSwap) => ({
                ...s,
                fromAmount: "0",
                fundingIntent: {
                    ...s.fundingIntent!,
                    output: { ...s.fundingIntent!.output, value: "0" },
                },
            }),
        ],
        [
            "over-supply btc",
            (s: AssetSwap) => ({
                ...s,
                fromAmount: "2100000000000001",
                fundingIntent: {
                    ...s.fundingIntent!,
                    output: { ...s.fundingIntent!.output, value: "2100000000000001" },
                },
            }),
        ],
        ["noncanonical asset id", (s: AssetSwap) => ({ ...s, toAsset: ASSET_ID.toUpperCase() })],
        ["zero asset amount", (s: AssetSwap) => ({ ...s, toAmount: "0" })],
        ["asset uint64 overflow", (s: AssetSwap) => ({ ...s, toAmount: "18446744073709551616" })],
        [
            "unknown descriptor field",
            (s: AssetSwap) => ({ ...s, fundingIntent: { ...s.fundingIntent!, extra: true } }),
        ],
    ])("rejects %s", async (_, mutate) => {
        await using repository = create();
        await expect(
            repository.insertPreparedSwap(mutate(prepared("operation-a")) as AssetSwap),
        ).rejects.toThrow();
    });

    it("accepts an exact asset funding output and preserves extra fields", async () => {
        await using repository = create();
        const value = prepared("operation-asset");
        value.fromAsset = ASSET_ID;
        value.toAsset = "btc";
        value.fromAmount = "18446744073709551615";
        value.toAmount = "1000";
        value.fundingIntent!.output = {
            script: SCRIPT,
            value: "330",
            assetId: ASSET_ID,
            assetAmount: value.fromAmount,
        };
        expect(await repository.insertPreparedSwap(value)).toBe(true);
        expect(await repository.getSwap(value.id)).toEqual(value);
    });
});

const falseyIntents = [null, false, 0, ""] as const;

describe.each(corruptBackends)("corrupt persisted funding intent ($name)", ({ open }) => {
    it.each(falseyIntents)("fails an insert scan for %j", async (fundingIntent) => {
        const harness = await open();
        await using repository = harness.repository;
        await harness.seed({ ...legacy("corrupt"), fundingIntent } as never);
        await expect(repository.insertPreparedSwap(prepared("operation-a"))).rejects.toThrow();
    });

    it.each(falseyIntents)("fails an ordinary save for %j", async (fundingIntent) => {
        const harness = await open();
        await using repository = harness.repository;
        await harness.seed({ ...legacy("corrupt"), fundingIntent } as never);
        await expect(
            repository.saveSwap({ ...legacy("corrupt"), status: "fulfilled" }),
        ).rejects.toThrow();
        expect((await repository.getSwap("corrupt"))?.fundingIntent).toBe(fundingIntent);
    });

    it.each(falseyIntents)("fails a state CAS for %j", async (fundingIntent) => {
        const harness = await open();
        await using repository = harness.repository;
        await harness.seed({ ...legacy("corrupt"), fundingIntent } as never);
        await expect(
            repository.advanceFundingState("corrupt", "prepared", { state: "submitted" }),
        ).rejects.toThrow();
    });

    it("fails closed on a persisted bound array txid", async () => {
        const harness = await open();
        await using repository = harness.repository;
        const corrupt = prepared("corrupt");
        corrupt.fundingIntent = { ...corrupt.fundingIntent!, state: "bound" };
        (corrupt as unknown as { fundingTxid: unknown }).fundingTxid = [BOUND_TXID];
        await harness.seed(corrupt);
        await expect(repository.insertPreparedSwap(prepared("operation-a"))).rejects.toThrow();
    });
});

describe("prepared funding concurrency", () => {
    it("fails closed when a stored funding descriptor is corrupt", () => {
        const corrupt = prepared("corrupt");
        corrupt.fundingIntent!.serverPubkey = "ff".repeat(32);
        expect(() => canInsertPreparedSwap([corrupt], prepared("operation-a"))).toThrow();
    });

    it("allows exactly one overlapping insert across IndexedDB connections", async () => {
        const name = `funding-race-${Math.random()}`;
        await using first = new IndexedDbAssetSwapRepository(name);
        await using second = new IndexedDbAssetSwapRepository(name);
        const results = await Promise.all([
            first.insertPreparedSwap(prepared("operation-a")),
            second.insertPreparedSwap(prepared("operation-b")),
        ]);
        expect(results.sort()).toEqual([false, true]);
    });

    it("allows exactly one overlapping insert across repositories sharing SQLite", async () => {
        const db = createNodeSQLExecutor();
        await using first = new SQLiteAssetSwapRepository(db);
        await using second = new SQLiteAssetSwapRepository(db);
        const results = await Promise.all([
            first.insertPreparedSwap(prepared("operation-a")),
            second.insertPreparedSwap(prepared("operation-b")),
        ]);
        expect(results.sort()).toEqual([false, true]);
    });

    it("allows exactly one overlapping insert across repositories sharing Realm", async () => {
        const db = realm();
        await using first = new RealmAssetSwapRepository(db);
        await using second = new RealmAssetSwapRepository(db);
        const results = await Promise.all([
            first.insertPreparedSwap(prepared("operation-a")),
            second.insertPreparedSwap(prepared("operation-b")),
        ]);
        expect(results.sort()).toEqual([false, true]);
    });

    it("reopens an IndexedDB prepared row with extra fields intact", async () => {
        const name = `funding-reopen-${Math.random()}`;
        const value = prepared("operation-a");
        {
            await using repository = new IndexedDbAssetSwapRepository(name);
            expect(await repository.insertPreparedSwap(value)).toBe(true);
        }
        {
            await using repository = new IndexedDbAssetSwapRepository(name);
            expect(await repository.getSwap(value.id)).toEqual(value);
        }
    });
});
