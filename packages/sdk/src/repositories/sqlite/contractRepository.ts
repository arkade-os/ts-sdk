import { Contract, ContractState, ContractWatchState } from "../../contracts/types";
import {
    contractFilterMatchesNothing,
    ContractFilter,
    ContractRepository,
} from "../contractRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";
import { SQLExecutor } from "./types";
import { sanitizeTablePrefix } from "./prefix";

interface SQLiteContractRepositoryOptions {
    /** Table name prefix (default: "ark_") */
    prefix?: string;
}

/**
 * SQLite-based implementation of ContractRepository.
 *
 * Uses the SQLExecutor interface so consumers can plug in any SQLite driver
 * (expo-sqlite, better-sqlite3, etc.).
 *
 * Tables are created lazily on first operation via `ensureInit()`.
 * The consumer owns the SQLExecutor lifecycle — `[Symbol.asyncDispose]` is a no-op.
 */
export class SQLiteContractRepository implements ContractRepository {
    readonly version = 3 as const;
    private initPromise: Promise<void> | null = null;
    private readonly prefix: string;
    private readonly table: string;

    constructor(
        private readonly db: SQLExecutor,
        options?: SQLiteContractRepositoryOptions,
    ) {
        this.prefix = sanitizeTablePrefix(options?.prefix ?? "ark_");
        this.table = `${this.prefix}contracts`;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    private ensureInit(): Promise<void> {
        if (!this.initPromise) {
            this.initPromise = this.init();
        }
        return this.initPromise;
    }

    private async init(): Promise<void> {
        await this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.table} (
                script TEXT PRIMARY KEY,
                address TEXT NOT NULL,
                type TEXT NOT NULL,
                state TEXT NOT NULL,
                params_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER,
                label TEXT,
                metadata_json TEXT,
                watch TEXT
            )
        `);

        // Nullable and added in place, so a table created before the
        // column existed keeps every row and reads back as "watched" —
        // the coverage those rows have today.
        await this.addColumnIfMissing("watch", "TEXT");

        await this.db.run(
            `CREATE INDEX IF NOT EXISTS idx_${this.prefix}contracts_type ON ${this.table} (type)`,
        );
        await this.db.run(
            `CREATE INDEX IF NOT EXISTS idx_${this.prefix}contracts_state ON ${this.table} (state)`,
        );
    }

    private async addColumnIfMissing(column: string, type: string): Promise<void> {
        const columns = await this.db.all<{ name: string }>(`PRAGMA table_info(${this.table})`);
        if (columns.some((c) => c.name === column)) return;
        await this.db.run(`ALTER TABLE ${this.table} ADD COLUMN ${column} ${type}`);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // no-op — consumer owns the SQLExecutor lifecycle
    }

    // ── Clear ──────────────────────────────────────────────────────────

    async clear(): Promise<void> {
        await this.ensureInit();
        await this.db.run(`DELETE FROM ${this.table}`);
    }

    // ── Contract management ────────────────────────────────────────────

    async getContractsPage(
        filter: ContractFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<Contract>> {
        assertPageRequest(page);
        await this.ensureInit();
        if (contractFilterMatchesNothing(filter)) return { items: [] };
        const conditions: string[] = [];
        const params: unknown[] = [];
        if (filter) {
            this.addFilterCondition(conditions, params, "script", filter.script);
            this.addFilterCondition(conditions, params, "state", filter.state);
            this.addFilterCondition(conditions, params, "type", filter.type);
            this.addWatchCondition(conditions, params, filter.watch);
        }
        if (page.after !== undefined) {
            conditions.push("script > ?");
            params.push(page.after);
        }
        const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
        const rows = await this.db.all<ContractRow>(
            `SELECT * FROM ${this.table}${where} ORDER BY script LIMIT ?`,
            [...params, page.limit + 1],
        );
        return pageResult(rows.map(contractRowToDomain), page.limit, (contract) => contract.script);
    }

    async saveContract(contract: Contract): Promise<void> {
        await this.ensureInit();
        await this.db.run(
            `INSERT OR REPLACE INTO ${this.table}
                (script, address, type, state, params_json,
                 created_at, label, metadata_json, watch)
             VALUES (?, ?, ?, ?, ?,
                     ?, ?, ?, ?)`,
            [
                contract.script,
                contract.address,
                contract.type,
                contract.state,
                JSON.stringify(contract.params),
                contract.createdAt,
                contract.label ?? null,
                contract.metadata ? JSON.stringify(contract.metadata) : null,
                contract.watch ?? null,
            ],
        );
    }

    async deleteContract(script: string): Promise<void> {
        await this.ensureInit();
        await this.db.run(`DELETE FROM ${this.table} WHERE script = ?`, [script]);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private addFilterCondition(
        conditions: string[],
        params: unknown[],
        column: string,
        value?: string | string[],
    ): void {
        if (value === undefined) return;

        if (Array.isArray(value)) {
            if (value.length === 0) return;
            const placeholders = value.map(() => "?").join(", ");
            conditions.push(`${column} IN (${placeholders})`);
            params.push(...value);
        } else {
            conditions.push(`${column} = ?`);
            params.push(value);
        }
    }

    /**
     * Same as {@link addFilterCondition}, except a row predating the
     * column stores NULL and must match `"watched"`.
     */
    private addWatchCondition(
        conditions: string[],
        params: unknown[],
        value?: ContractWatchState | ContractWatchState[],
    ): void {
        if (value === undefined) return;

        const wanted = Array.isArray(value) ? value : [value];
        if (wanted.length === 0) return;

        const placeholders = wanted.map(() => "?").join(", ");
        const clause = `watch IN (${placeholders})`;
        conditions.push(wanted.includes("watched") ? `(${clause} OR watch IS NULL)` : clause);
        params.push(...wanted);
    }
}

// ── Row type ────────────────────────────────────────────────────────────

interface ContractRow {
    script: string;
    address: string;
    type: string;
    state: string;
    params_json: string;
    created_at: number;
    label: string | null;
    metadata_json: string | null;
    watch: string | null;
}

// ── Row → Domain converter ──────────────────────────────────────────────

function contractRowToDomain(row: ContractRow): Contract {
    const contract: Contract = {
        script: row.script,
        address: row.address,
        type: row.type,
        state: row.state as ContractState,
        params: JSON.parse(row.params_json),
        createdAt: row.created_at,
    };

    if (row.label !== null) {
        contract.label = row.label;
    }
    if (row.metadata_json !== null) {
        contract.metadata = JSON.parse(row.metadata_json);
    }
    if (row.watch !== null && row.watch !== undefined) {
        contract.watch = row.watch as ContractWatchState;
    }

    return contract;
}
