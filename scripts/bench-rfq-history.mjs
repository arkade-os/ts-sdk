import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const count = Number(process.argv[2] ?? 1000);
const mode = process.argv[3] ?? "prune";
if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !["read", "prune", "upgrade", "restore-recent", "restore-expired", "page-recent"].includes(mode)
) {
    throw new Error(
        "usage: node --expose-gc --experimental-sqlite scripts/bench-rfq-history.mjs <count> <read|prune|upgrade|restore-recent|restore-expired|page-recent>",
    );
}

const keepEvery = Number(process.env.BENCH_KEEP_EVERY ?? 0);
const file =
    process.env.BENCH_DB_PATH ?? join(tmpdir(), `arkade-rfq-history-${randomUUID()}.sqlite`);
const { SQLiteAssetSwapRepository } = await import(
    "../packages/swap/dist/repositories/sqlite/index.js"
);
const { RfqSwapManager } = await import("../packages/swap/dist/index.js");
const db = new DatabaseSync(file);
const bind = (params = []) => params.map((value) => (value === undefined ? null : value));
const sql = {
    run: async (query, params) => {
        db.prepare(query).run(...bind(params));
    },
    get: async (query, params) => db.prepare(query).get(...bind(params)),
    all: async (query, params) => db.prepare(query).all(...bind(params)),
};
const repository = new SQLiteAssetSwapRepository(sql);

if (mode === "upgrade") {
    db.exec(
        "CREATE TABLE arkade_rfq_swaps (rfq_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)",
    );
    db.exec("CREATE INDEX idx_arkade_rfq_swaps_state ON arkade_rfq_swaps (state)");
} else {
    await repository.getAllRfqSwaps();
}

const insert = db.prepare(
    "INSERT INTO arkade_rfq_swaps (rfq_id, state, updated_at, data) VALUES (?, ?, ?, ?)",
);
const seedStarted = performance.now();
db.exec("BEGIN");
for (let i = 0; i < count; i++) {
    const rfqId = i.toString(16).padStart(64, "0");
    // Minimal records make the read-memory result a lower bound for real swaps.
    const record = {
        rfqId,
        kind: "lightning_send",
        state: keepEvery && i % keepEvery === 0 ? "pending" : "settled",
        lockupAddress: "tark1q",
        profile: {},
        createdAt: 1,
        updatedAt: mode.endsWith("-recent") ? 1_800_000_000 : 1,
    };
    insert.run(rfqId, record.state, record.updatedAt, JSON.stringify(record));
}
db.exec("COMMIT");
const seedMs = Math.round(performance.now() - seedStarted);
global.gc?.();
const before = process.memoryUsage();
let peakRss = before.rss;
let peakHeap = before.heapUsed;
const sample = setInterval(() => {
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeap = Math.max(peakHeap, usage.heapUsed);
}, 25);

const started = performance.now();
let returned;
if (mode === "read") {
    let records = await repository.getAllRfqSwaps();
    returned = records.length;
    records = undefined;
} else if (mode === "restore-recent" || mode === "restore-expired") {
    const manager = new RfqSwapManager({ indexer: {}, repository }, { now: () => 1_800_000_000 });
    const result = await manager.restoreFromRepository({
        params: async () => {
            throw new Error("no active records expected");
        },
    });
    returned = {
        restored: result.restored.length,
        failed: result.failed.length,
        pruned: result.pruned.length,
        prunedCount: result.prunedCount,
    };
} else if (mode === "page-recent") {
    returned = 0;
    let cursor;
    for (;;) {
        const page = await repository.getRfqSwapsPage("settled", cursor, 500);
        returned += page.length;
        if (page.length < 500) break;
        cursor = page[page.length - 1].rfqId;
    }
} else {
    const manager = new RfqSwapManager({ indexer: {}, repository }, { now: () => 1_800_000_000 });
    returned = (await manager.pruneRetiredSwaps()).length;
}
const elapsedMs = Math.round(performance.now() - started);
clearInterval(sample);
const after = process.memoryUsage();
peakRss = Math.max(peakRss, after.rss);
peakHeap = Math.max(peakHeap, after.heapUsed);
const remaining = db.prepare("SELECT COUNT(*) AS n FROM arkade_rfq_swaps").get().n;
const dbMiB = Math.round(statSync(file).size / 1048576);
db.close();
if (!process.env.BENCH_DB_PATH) unlinkSync(file);

console.log(
    JSON.stringify({
        count,
        mode,
        keepEvery,
        seedMs,
        elapsedMs,
        returned,
        remaining,
        dbMiB,
        beforeMiB: {
            rss: Math.round(before.rss / 1048576),
            heap: Math.round(before.heapUsed / 1048576),
        },
        afterMiB: {
            rss: Math.round(after.rss / 1048576),
            heap: Math.round(after.heapUsed / 1048576),
        },
        peakMiB: {
            rss: Math.round(peakRss / 1048576),
            heap: Math.round(peakHeap / 1048576),
        },
    }),
);
