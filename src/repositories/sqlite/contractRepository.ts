import { Contract, ContractState } from "../../contracts/types";
import { ContractFilter, ContractRepository } from "../contractRepository";
import { SQLExecutor } from "./types";

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
    readonly version = 1 as const;
    private initPromise: Promise<void> | null = null;
    private readonly prefix: string;
    private readonly table: string;

    constructor(
        private readonly db: SQLExecutor,
        options?: SQLiteContractRepositoryOptions
    ) {
        this.prefix = options?.prefix ?? "ark_";
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
                metadata_json TEXT
            )
        `);

        await this.db.run(
            `CREATE INDEX IF NOT EXISTS idx_${this.prefix}contracts_type ON ${this.table} (type)`
        );
        await this.db.run(
            `CREATE INDEX IF NOT EXISTS idx_${this.prefix}contracts_state ON ${this.table} (state)`
        );
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

    async getContracts(filter?: ContractFilter): Promise<Contract[]> {
        await this.ensureInit();

        const conditions: string[] = [];
        const params: unknown[] = [];

        if (filter) {
            this.addFilterCondition(
                conditions,
                params,
                "script",
                filter.script
            );
            this.addFilterCondition(conditions, params, "state", filter.state);
            this.addFilterCondition(conditions, params, "type", filter.type);
        }

        let sql = `SELECT * FROM ${this.table}`;
        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(" AND ")}`;
        }

        const rows = await this.db.all<ContractRow>(sql, params);
        return rows.map(contractRowToDomain);
    }

    async saveContract(contract: Contract): Promise<void> {
        await this.ensureInit();
        await this.db.run(
            `INSERT OR REPLACE INTO ${this.table}
                (script, address, type, state, params_json,
                 created_at, expires_at, label, metadata_json)
             VALUES (?, ?, ?, ?, ?,
                     ?, ?, ?, ?)`,
            [
                contract.script,
                contract.address,
                contract.type,
                contract.state,
                JSON.stringify(contract.params),
                contract.createdAt,
                contract.expiresAt ?? null,
                contract.label ?? null,
                contract.metadata ? JSON.stringify(contract.metadata) : null,
            ]
        );
    }

    async deleteContract(script: string): Promise<void> {
        await this.ensureInit();
        await this.db.run(`DELETE FROM ${this.table} WHERE script = ?`, [
            script,
        ]);
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private addFilterCondition(
        conditions: string[],
        params: unknown[],
        column: string,
        value?: string | string[]
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
}

// ── Row type ────────────────────────────────────────────────────────────

interface ContractRow {
    script: string;
    address: string;
    type: string;
    state: string;
    params_json: string;
    created_at: number;
    expires_at: number | null;
    label: string | null;
    metadata_json: string | null;
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

    if (row.expires_at !== null) {
        contract.expiresAt = row.expires_at;
    }
    if (row.label !== null) {
        contract.label = row.label;
    }
    if (row.metadata_json !== null) {
        contract.metadata = JSON.parse(row.metadata_json);
    }

    return contract;
}
