import type { SQLExecutor } from "../../src/repositories/sqlite/types";

// A lightweight in-memory SQL engine that supports the subset of SQL used by
// the SQLite repositories: CREATE TABLE, CREATE [UNIQUE] INDEX, INSERT OR
// REPLACE, SELECT (incl. COUNT(*), multi-column WHERE/ORDER BY), DELETE,
// the vtxos-migration rebuild (DROP/RENAME/INSERT...SELECT/ALTER ADD COLUMN),
// and BEGIN/COMMIT/ROLLBACK as no-ops.

interface TableDef {
    primaryKey: string[];
    rows: Map<string, Record<string, unknown>>;
}

function parseCreateTable(sql: string): { name: string; pk: string[] } {
    const nameMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
    if (!nameMatch) throw new Error(`Cannot parse CREATE TABLE: ${sql}`);
    const name = nameMatch[1];
    const pkMatch = sql.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
    let pk: string[] = [];
    if (pkMatch) {
        pk = pkMatch[1].split(",").map((s) => s.trim());
    } else {
        const colPkMatch = sql.match(/(\w+)\s+TEXT\s+PRIMARY\s+KEY/i);
        if (colPkMatch) pk = [colPkMatch[1]];
    }
    return { name, pk };
}

function parseInsertOrReplace(sql: string): {
    table: string;
    columns: string[];
} {
    const match = sql.match(/INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)/i);
    if (!match) throw new Error(`Cannot parse INSERT OR REPLACE: ${sql}`);
    return {
        table: match[1],
        columns: match[2].split(",").map((s) => s.trim()),
    };
}

/** Equality columns from a `WHERE a = ? AND b = ?` clause, in order. */
function parseWhereCols(sql: string): string[] {
    const whereMatch = sql.match(/WHERE\s+([\s\S]+?)(?:\s+ORDER\s+BY|\s*$)/i);
    if (!whereMatch) return [];
    return [...whereMatch[1].matchAll(/(\w+)\s*=\s*\?/gi)].map((m) => m[1]);
}

function parseOrderBys(sql: string): { col: string; dir: string }[] {
    const m = sql.match(/ORDER\s+BY\s+([\s\S]+?)\s*$/i);
    if (!m) return [];
    return m[1].split(",").map((part) => {
        const [, col, dir = "ASC"] = part.trim().match(/(\w+)\s*(ASC|DESC)?/i) ?? [];
        return { col, dir: dir.toUpperCase() };
    });
}

export function createMockSQLExecutor(): SQLExecutor {
    const tables = new Map<string, TableDef>();

    const getTable = (name: string): TableDef => {
        const t = tables.get(name);
        if (!t) throw new Error(`Table ${name} does not exist`);
        return t;
    };
    const rowKey = (pk: string[], row: Record<string, unknown>): string =>
        pk.map((col) => String(row[col] ?? "")).join("\x00");

    const filterRows = (
        t: TableDef,
        whereCols: string[],
        params?: unknown[],
    ): Record<string, unknown>[] => {
        const rows = Array.from(t.rows.values());
        if (whereCols.length === 0) return rows;
        return rows.filter((row) => whereCols.every((col, i) => row[col] === params?.[i]));
    };

    const applyOrder = (
        rows: Record<string, unknown>[],
        orderBys: { col: string; dir: string }[],
    ): Record<string, unknown>[] => {
        if (orderBys.length === 0) return rows;
        return [...rows].sort((a, b) => {
            for (const { col, dir } of orderBys) {
                const va = a[col] as number | string;
                const vb = b[col] as number | string;
                const cmp = va < vb ? -1 : va > vb ? 1 : 0;
                if (cmp !== 0) return dir === "DESC" ? -cmp : cmp;
            }
            return 0;
        });
    };

    return {
        async run(sql: string, params?: unknown[]): Promise<void> {
            const trimmed = sql.trim();

            if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(trimmed)) return;

            if (/^CREATE\s+TABLE/i.test(trimmed)) {
                const ifNotExists = /IF\s+NOT\s+EXISTS/i.test(trimmed);
                const { name, pk } = parseCreateTable(trimmed);
                if (!tables.has(name)) {
                    tables.set(name, { primaryKey: pk, rows: new Map() });
                } else if (!ifNotExists) {
                    throw new Error(`Table ${name} already exists`);
                }
                return;
            }

            const dropMatch = trimmed.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
            if (dropMatch) {
                const tableName = dropMatch[1];
                if (!tables.has(tableName) && !/IF\s+EXISTS/i.test(trimmed)) {
                    throw new Error(`Table ${tableName} does not exist`);
                }
                tables.delete(tableName);
                return;
            }

            const renameMatch = trimmed.match(/^ALTER\s+TABLE\s+(\w+)\s+RENAME\s+TO\s+(\w+)/i);
            if (renameMatch) {
                const [, oldName, newName] = renameMatch;
                const t = tables.get(oldName);
                if (!t) throw new Error(`Table ${oldName} does not exist`);
                tables.delete(oldName);
                tables.set(newName, t);
                return;
            }

            const insertSelectMatch = trimmed.match(
                /^INSERT\s+INTO\s+(\w+)\s*\([^)]+\)\s*SELECT\s+[\s\S]+\s+FROM\s+(\w+)/i,
            );
            if (insertSelectMatch) {
                const [, dest, src] = insertSelectMatch;
                const s = tables.get(src);
                const d = tables.get(dest);
                if (!s) throw new Error(`Table ${src} does not exist`);
                if (!d) throw new Error(`Table ${dest} does not exist`);
                for (const row of s.rows.values())
                    d.rows.set(rowKey(d.primaryKey, row), { ...row });
                return;
            }

            const updateMatch = trimmed.match(
                /^UPDATE\s+(\w+)\s+SET\s+(\w+)\s*=\s*\?\s+WHERE\s+(\w+)\s*=\s*\?\s+AND\s+(\w+)\s*=\s*\?/i,
            );
            if (updateMatch) {
                const [, tableName, setCol, whereCol1, whereCol2] = updateMatch;
                const t = getTable(tableName);
                for (const row of t.rows.values()) {
                    if (row[whereCol1] === params?.[1] && row[whereCol2] === params?.[2]) {
                        row[setCol] = params?.[0];
                    }
                }
                return;
            }

            if (/^INSERT\s+OR\s+REPLACE/i.test(trimmed)) {
                const { table, columns } = parseInsertOrReplace(trimmed);
                const t = getTable(table);
                const row: Record<string, unknown> = {};
                columns.forEach((col, i) => {
                    row[col] = params?.[i] ?? null;
                });
                t.rows.set(rowKey(t.primaryKey, row), row);
                return;
            }

            if (/^DELETE/i.test(trimmed)) {
                const tableMatch = trimmed.match(/DELETE\s+FROM\s+(\w+)/i);
                if (!tableMatch) throw new Error(`Cannot parse DELETE: ${trimmed}`);
                const t = getTable(tableMatch[1]);
                // DELETE ... WHERE (txid = ? AND vout = ?) [OR (...)] — by outpoint pairs.
                if (/WHERE\s+\(txid\s*=\s*\?\s+AND\s+vout\s*=\s*\?\)/i.test(trimmed) && params) {
                    const targets = new Set<string>();
                    for (let i = 0; i + 1 < params.length; i += 2) {
                        targets.add(`${String(params[i])}\x00${String(params[i + 1])}`);
                    }
                    for (const [key, row] of t.rows) {
                        if (targets.has(`${String(row.txid)}\x00${String(row.vout)}`)) {
                            t.rows.delete(key);
                        }
                    }
                    return;
                }
                const whereCols = parseWhereCols(trimmed);
                if (whereCols.length === 0) {
                    t.rows.clear();
                    return;
                }
                for (const [key, row] of t.rows)
                    if (whereCols.every((c, i) => row[c] === params?.[i])) t.rows.delete(key);
                return;
            }

            if (/^CREATE\s+(UNIQUE\s+)?INDEX/i.test(trimmed)) return;

            const alterMatch = trimmed.match(/^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i);
            if (alterMatch) {
                const [, tableName, colName] = alterMatch;
                const t = tables.get(tableName);
                if (!t) throw new Error(`Table ${tableName} does not exist`);
                const sample = t.rows.values().next();
                if (!sample.done && colName in (sample.value as object)) {
                    throw new Error(`duplicate column name: ${colName}`);
                }
                return;
            }

            throw new Error(`Unsupported SQL in run(): ${trimmed}`);
        },

        async get<T = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
        ): Promise<T | undefined> {
            const trimmed = sql.trim();

            if (/^SELECT\s+name\s+FROM\s+sqlite_master/i.test(trimmed)) {
                const name = params?.[0] as string | undefined;
                return name && tables.has(name) ? ({ name } as T) : undefined;
            }

            const countMatch = trimmed.match(/^SELECT\s+COUNT\(\*\)\s+AS\s+(\w+)\s+FROM\s+(\w+)/i);
            if (countMatch) {
                const [, alias, tableName] = countMatch;
                const t = getTable(tableName);
                const n = filterRows(t, parseWhereCols(trimmed), params).length;
                return { [alias]: n } as T;
            }

            const tableMatch = trimmed.match(/SELECT\s+\*\s+FROM\s+(\w+)/i);
            if (!tableMatch) throw new Error(`Cannot parse SELECT: ${trimmed}`);
            const t = getTable(tableMatch[1]);
            const rows = filterRows(t, parseWhereCols(trimmed), params);
            return rows.length ? (rows[0] as T) : undefined;
        },

        async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
            const trimmed = sql.trim();

            const pragmaMatch = trimmed.match(/^PRAGMA\s+table_info\s*\(\s*(\w+)\s*\)/i);
            if (pragmaMatch) {
                const t = tables.get(pragmaMatch[1]);
                if (!t) return [] as T[];
                const sample = t.rows.values().next();
                if (sample.done) return [] as T[];
                return Object.keys(sample.value as object).map((name) => ({
                    name,
                    notnull: 1,
                })) as T[];
            }

            const tableMatch = trimmed.match(/SELECT\s+\*\s+FROM\s+(\w+)/i);
            if (!tableMatch) throw new Error(`Cannot parse SELECT: ${trimmed}`);
            const t = getTable(tableMatch[1]);
            const rows = filterRows(t, parseWhereCols(trimmed), params);
            return applyOrder(rows, parseOrderBys(trimmed)) as T[];
        },
    };
}
