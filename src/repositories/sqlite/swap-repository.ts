import type { SQLExecutor } from "@arkade-os/sdk/repositories/sqlite";
import type {
    GetSwapsFilter,
    PendingSwap,
    SwapRepository,
} from "../swap-repository";

interface SwapRow {
    id: string;
    type: string;
    status: string;
    created_at: number;
    data: string;
}

/**
 * SQLite-based implementation of SwapRepository.
 *
 * Uses the SQLExecutor interface so consumers can plug in any SQLite driver
 * (expo-sqlite, better-sqlite3, etc.).
 *
 * Tables are created lazily on first operation via `ensureInit()`.
 * The consumer owns the SQLExecutor lifecycle — `[Symbol.asyncDispose]` is a no-op.
 */
export class SQLiteSwapRepository implements SwapRepository {
    readonly version = 1 as const;
    private initPromise: Promise<void> | null = null;

    constructor(private readonly executor: SQLExecutor) {}

    // ── Lifecycle ──────────────────────────────────────────────────────

    private ensureInit(): Promise<void> {
        if (!this.initPromise) {
            this.initPromise = this.init();
        }
        return this.initPromise;
    }

    private async init(): Promise<void> {
        await this.executor.run(`
            CREATE TABLE IF NOT EXISTS boltz_swaps (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                data TEXT NOT NULL
            )
        `);
        await this.executor.run(
            `CREATE INDEX IF NOT EXISTS idx_boltz_swaps_status ON boltz_swaps(status)`
        );
        await this.executor.run(
            `CREATE INDEX IF NOT EXISTS idx_boltz_swaps_type ON boltz_swaps(type)`
        );
        await this.executor.run(
            `CREATE INDEX IF NOT EXISTS idx_boltz_swaps_created_at ON boltz_swaps(created_at)`
        );
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // no-op — consumer owns the SQLExecutor lifecycle
    }

    // ── Swap operations ────────────────────────────────────────────────

    async saveSwap<T extends PendingSwap>(swap: T): Promise<void> {
        await this.ensureInit();
        await this.executor.run(
            `INSERT OR REPLACE INTO boltz_swaps (id, type, status, created_at, data)
             VALUES (?, ?, ?, ?, ?)`,
            [swap.id, swap.type, swap.status, swap.createdAt, JSON.stringify(swap)]
        );
    }

    async deleteSwap(id: string): Promise<void> {
        await this.ensureInit();
        await this.executor.run(
            `DELETE FROM boltz_swaps WHERE id = ?`,
            [id]
        );
    }

    async getAllSwaps<T extends PendingSwap>(
        filter?: GetSwapsFilter
    ): Promise<T[]> {
        await this.ensureInit();

        // Early return for empty array filters (no possible matches)
        if (
            (Array.isArray(filter?.id) && filter.id.length === 0) ||
            (Array.isArray(filter?.status) && filter.status.length === 0) ||
            (Array.isArray(filter?.type) && filter.type.length === 0)
        ) {
            return [];
        }

        const conditions: string[] = [];
        const params: unknown[] = [];

        if (filter) {
            if (filter.id !== undefined) {
                if (Array.isArray(filter.id)) {
                    conditions.push(
                        `id IN (${filter.id.map(() => "?").join(",")})`
                    );
                    params.push(...filter.id);
                } else {
                    conditions.push(`id = ?`);
                    params.push(filter.id);
                }
            }

            if (filter.status !== undefined) {
                if (Array.isArray(filter.status)) {
                    conditions.push(
                        `status IN (${filter.status.map(() => "?").join(",")})`
                    );
                    params.push(...filter.status);
                } else {
                    conditions.push(`status = ?`);
                    params.push(filter.status);
                }
            }

            if (filter.type !== undefined) {
                if (Array.isArray(filter.type)) {
                    conditions.push(
                        `type IN (${filter.type.map(() => "?").join(",")})`
                    );
                    params.push(...filter.type);
                } else {
                    conditions.push(`type = ?`);
                    params.push(filter.type);
                }
            }
        }

        let sql = `SELECT data FROM boltz_swaps`;
        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(" AND ")}`;
        }

        if (filter?.orderBy === "createdAt") {
            const direction = filter.orderDirection === "desc" ? "DESC" : "ASC";
            sql += ` ORDER BY created_at ${direction}`;
        }

        const rows = await this.executor.all<Pick<SwapRow, "data">>(sql, params);
        return rows.map((row) => JSON.parse(row.data) as T);
    }

    async clear(): Promise<void> {
        await this.ensureInit();
        await this.executor.run(`DELETE FROM boltz_swaps`);
    }
}
