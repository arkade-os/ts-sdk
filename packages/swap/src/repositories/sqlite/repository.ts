import {
    runInTransaction,
    sanitizeTablePrefix,
    type SQLExecutor,
} from "@arkade-os/sdk/repositories/sqlite";
import {
    marketsCacheKey,
    type AssetSwapRepository,
    type MarketsCacheEntry,
} from "../../repository";
import type { AssetSwap } from "../../store";

const DEFAULT_PREFIX = "arkade_";
// SQLite's default parameter ceiling is 999; stay well under it per statement.
const INSERT_CHUNK = 500;

/**
 * SQLite backend over the SDK's `SQLExecutor`, so any driver plugs in
 * (expo-sqlite on React Native, better-sqlite3, node:sqlite).
 *
 * **Records are serialized as JSON**, whole, into a `data` column — `status`
 * and `created_at` are mapped out for querying only, so no field of a record
 * can be dropped. That holds for JSON-safe values: a consumer-added `Date`
 * comes back a string and a `bigint` throws on save, unlike the IndexedDB
 * backend's structured clone. `AssetSwap` itself is JSON-safe by design.
 *
 * Tables are created lazily on first operation. The consumer owns the
 * `SQLExecutor` lifecycle — `[Symbol.asyncDispose]` is a no-op — and must pass
 * the **same executor instance** to every repository on the database: the
 * write chain is keyed by that object, and a per-repository literal splits it.
 */
export class SQLiteAssetSwapRepository implements AssetSwapRepository {
    readonly version = 2 as const;
    private initPromise: Promise<void> | null = null;
    private readonly prefix: string;
    private readonly swaps: string;
    private readonly scanned: string;
    private readonly markets: string;

    constructor(
        private readonly db: SQLExecutor,
        options?: { prefix?: string },
    ) {
        this.prefix = sanitizeTablePrefix(options?.prefix ?? DEFAULT_PREFIX);
        this.swaps = `${this.prefix}asset_swaps`;
        this.scanned = `${this.prefix}asset_swap_scanned_txids`;
        this.markets = `${this.prefix}asset_swap_markets`;
    }

    /** A rejected init is not cached. The DDL runs in a transaction on a shared
     * connection, so it can fail for reasons that pass — a `SQLITE_BUSY` on
     * `BEGIN IMMEDIATE`, a neighbour's rollback — and caching that rejection
     * would strand the instance unusable for the life of the process. Same rule
     * as the IndexedDB backend's `ensureDb`. */
    private ensureInit(): Promise<void> {
        return (this.initPromise ??= this.init().catch((err) => {
            this.initPromise = null;
            throw err;
        }));
    }

    /** The DDL is transactional in SQLite too: run raw on a shared connection it
     * would join a neighbour's open transaction and vanish with its rollback,
     * while `initPromise` stayed resolved and every later statement failed with
     * `no such table`. */
    private async init(): Promise<void> {
        await this.withTx(async () => {
            await this.db.run(`CREATE TABLE IF NOT EXISTS ${this.swaps} (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                data TEXT NOT NULL
            )`);
            await this.db.run(
                `CREATE INDEX IF NOT EXISTS idx_${this.prefix}asset_swaps_status ON ${this.swaps} (status)`,
            );
            await this.db.run(
                `CREATE INDEX IF NOT EXISTS idx_${this.prefix}asset_swaps_created_at ON ${this.swaps} (created_at)`,
            );
            await this.db.run(`CREATE TABLE IF NOT EXISTS ${this.scanned} (txid TEXT PRIMARY KEY)`);
            await this.db.run(
                `CREATE TABLE IF NOT EXISTS ${this.markets} (cache_key TEXT PRIMARY KEY, data TEXT NOT NULL)`,
            );
        });
    }

    /** Every write, including the single-statement ones. The chain serializes
     * transaction *blocks*, not bare statements: one issued between a
     * neighbour's BEGIN IMMEDIATE and its COMMIT becomes part of that
     * transaction and dies with it. `fn` must issue only raw db calls — no
     * repository method, no `ensureInit` — since `runInTransaction` cannot
     * nest. */
    private withTx(fn: () => Promise<void>): Promise<void> {
        return runInTransaction(this.db, fn);
    }

    async saveSwap(swap: AssetSwap): Promise<void> {
        await this.ensureInit();
        await this.withTx(async () => {
            await this.db.run(
                `INSERT OR REPLACE INTO ${this.swaps} (id, status, created_at, data)
                 VALUES (?, ?, ?, ?)`,
                [swap.id, swap.status, swap.createdAt, JSON.stringify(swap)],
            );
        });
    }

    async getAllSwaps(): Promise<AssetSwap[]> {
        await this.ensureInit();
        const rows = await this.db.all<{ data: string }>(`SELECT data FROM ${this.swaps}`);
        return rows.map((r) => JSON.parse(r.data) as AssetSwap);
    }

    async getScannedTxids(): Promise<Set<string>> {
        await this.ensureInit();
        const rows = await this.db.all<{ txid: string }>(`SELECT txid FROM ${this.scanned}`);
        return new Set(rows.map((r) => r.txid));
    }

    async markTxidsScanned(txids: Iterable<string>): Promise<void> {
        await this.ensureInit();
        const all = [...txids];
        if (all.length === 0) return;
        await this.withTx(async () => {
            for (let i = 0; i < all.length; i += INSERT_CHUNK) {
                const chunk = all.slice(i, i + INSERT_CHUNK);
                await this.db.run(
                    `INSERT OR IGNORE INTO ${this.scanned} (txid) VALUES ${chunk
                        .map(() => "(?)")
                        .join(", ")}`,
                    chunk,
                );
            }
        });
    }

    async getCachedMarkets(
        network: string,
        registry: string,
    ): Promise<MarketsCacheEntry | undefined> {
        await this.ensureInit();
        const row = await this.db.get<{ data: string }>(
            `SELECT data FROM ${this.markets} WHERE cache_key = ?`,
            [marketsCacheKey(network, registry)],
        );
        return row ? (JSON.parse(row.data) as MarketsCacheEntry) : undefined;
    }

    async saveCachedMarkets(
        network: string,
        registry: string,
        entry: MarketsCacheEntry,
    ): Promise<void> {
        await this.ensureInit();
        await this.withTx(async () => {
            await this.db.run(
                `INSERT OR REPLACE INTO ${this.markets} (cache_key, data) VALUES (?, ?)`,
                [marketsCacheKey(network, registry), JSON.stringify(entry)],
            );
        });
    }

    /** All three tables in one transaction: clearing swaps but keeping scanned
     * txids would leave the restore scan permanently skipping those funding
     * txs, so a partial clear must not be observable. */
    async clear(): Promise<void> {
        await this.ensureInit();
        await this.withTx(async () => {
            await this.db.run(`DELETE FROM ${this.swaps}`);
            await this.db.run(`DELETE FROM ${this.scanned}`);
            await this.db.run(`DELETE FROM ${this.markets}`);
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // no-op — the consumer owns the SQLExecutor lifecycle
    }
}
