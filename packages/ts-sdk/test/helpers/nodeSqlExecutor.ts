import { DatabaseSync } from "node:sqlite";
import type { SQLExecutor } from "../../src/repositories/sqlite/types";

// A real in-memory SQLite engine backed by Node's built-in `node:sqlite`.
// Unlike the regex-based mock, it executes actual SQL (JOINs, `IN (...)`,
// correlated `NOT EXISTS`, …), so set-based repository queries are validated
// against the same semantics they get in production instead of a stand-in.
export function createNodeSQLExecutor(): SQLExecutor {
    const db = new DatabaseSync(":memory:");
    return {
        async run(sql: string, params?: unknown[]): Promise<void> {
            db.prepare(sql).run(...toBindable(params));
        },
        async get<T = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
        ): Promise<T | undefined> {
            return (db.prepare(sql).get(...toBindable(params)) as T | undefined) ?? undefined;
        },
        async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
            return db.prepare(sql).all(...toBindable(params)) as T[];
        },
    };
}

// node:sqlite binds `undefined` as an error; normalise to `null`.
function toBindable(params?: unknown[]): (null | unknown)[] {
    return (params ?? []).map((p) => (p === undefined ? null : p));
}
