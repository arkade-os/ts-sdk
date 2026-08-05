/**
 * Durable storage for the mainnet example, on `node:sqlite` — built into
 * Node 24, so the examples pull in no database dependency.
 *
 * Two pieces, one file on disk: an `SQLExecutor` adapter, so the SDK's SQLite
 * wallet and contract repositories can use it, and an `AssetSwapRepository`
 * over a single key/value table.
 */
import { DatabaseSync } from "node:sqlite";

import type { SQLExecutor } from "@arkade-os/sdk/repositories/sqlite";

import type { AssetSwap, AssetSwapRepository, MarketsCacheEntry } from "../../src/index.js";

/** The SDK's repositories speak async SQL; `node:sqlite` is synchronous, so
 * the adapter is just a promise wrapper. */
export const createSQLExecutor = (db: DatabaseSync): SQLExecutor => ({
    run: async (sql, params) => {
        db.prepare(sql).run(...((params ?? []) as never[]));
    },
    get: async <T>(sql: string, params?: unknown[]) =>
        db.prepare(sql).get(...((params ?? []) as never[])) as T | undefined,
    all: async <T>(sql: string, params?: unknown[]) =>
        db.prepare(sql).all(...((params ?? []) as never[])) as T[],
});

/**
 * Everything the swap package persists, in one table: swap records under
 * `swap:<id>`, the restore-scan cursor under `scanned`, and the markets cache
 * under `markets:<network>:<registry>`. The key layout is this backend's own
 * business — the interface hands over network and registry separately.
 *
 * Single-process only: `markTxidsScanned` is read-modify-write, so two
 * processes sharing the file could lose txids from the cursor (they would be
 * rescanned, not lost for good).
 */
export class SqliteAssetSwapRepository implements AssetSwapRepository {
    readonly version = 1 as const;

    constructor(private readonly db: DatabaseSync) {
        db.exec("CREATE TABLE IF NOT EXISTS swap_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    }

    private put(key: string, value: unknown): void {
        this.db
            .prepare(
                "INSERT INTO swap_kv (key, value) VALUES (?, ?) " +
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .run(key, JSON.stringify(value));
    }

    private read<T>(key: string): T | undefined {
        const row = this.db.prepare("SELECT value FROM swap_kv WHERE key = ?").get(key) as
            | { value: string }
            | undefined;
        return row ? (JSON.parse(row.value) as T) : undefined;
    }

    async saveSwap(swap: AssetSwap): Promise<void> {
        this.put(`swap:${swap.id}`, swap);
    }

    async getAllSwaps(): Promise<AssetSwap[]> {
        const rows = this.db
            .prepare("SELECT value FROM swap_kv WHERE key LIKE 'swap:%'")
            .all() as Array<{ value: string }>;
        return rows.map((row) => JSON.parse(row.value) as AssetSwap);
    }

    async getScannedTxids(): Promise<Set<string>> {
        return new Set(this.read<string[]>("scanned") ?? []);
    }

    async markTxidsScanned(txids: Iterable<string>): Promise<void> {
        const scanned = await this.getScannedTxids();
        for (const txid of txids) scanned.add(txid);
        this.put("scanned", [...scanned]);
    }

    async getCachedMarkets(
        network: string,
        registry: string,
    ): Promise<MarketsCacheEntry | undefined> {
        return this.read<MarketsCacheEntry>(`markets:${network}:${registry}`);
    }

    async saveCachedMarkets(
        network: string,
        registry: string,
        entry: MarketsCacheEntry,
    ): Promise<void> {
        this.put(`markets:${network}:${registry}`, entry);
    }

    async clear(): Promise<void> {
        this.db.exec("DELETE FROM swap_kv");
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // the caller owns the database handle, as with the SDK's SQLite
        // repositories; disposing releases resources, it never deletes data
    }
}
