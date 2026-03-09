import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteContractRepository } from "../src/repositories/sqlite/contractRepository";
import type { SQLExecutor } from "../src/repositories/sqlite/types";
import type { Contract, ContractState } from "../src/contracts/types";

// ── Mock SQLExecutor ────────────────────────────────────────────────────
// A lightweight in-memory SQL engine that supports the subset of SQL
// used by SQLiteContractRepository: CREATE TABLE, INSERT OR REPLACE,
// SELECT with WHERE (=, IN, AND), DELETE, and CREATE INDEX.

interface TableDef {
    primaryKey: string[];
    rows: Map<string, Record<string, unknown>>;
}

function createMockSQLExecutor(): SQLExecutor {
    const tables = new Map<string, TableDef>();

    function parseCreateTable(sql: string): { name: string; pk: string[] } {
        const nameMatch = sql.match(
            /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i
        );
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
        const match = sql.match(
            /INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)/i
        );
        if (!match) throw new Error(`Cannot parse INSERT OR REPLACE: ${sql}`);
        const table = match[1];
        const columns = match[2].split(",").map((s) => s.trim());
        return { table, columns };
    }

    /**
     * Parse a SELECT statement with optional WHERE clause supporting
     * `col = ?`, `col IN (?, ?, ...)`, and multiple conditions joined with AND.
     */
    function parseSelect(sql: string): {
        table: string;
        conditions: Array<{
            column: string;
            op: "eq" | "in";
            paramCount: number;
        }>;
    } {
        const tableMatch = sql.match(/SELECT\s+\*\s+FROM\s+(\w+)/i);
        if (!tableMatch) throw new Error(`Cannot parse SELECT: ${sql}`);
        const table = tableMatch[1];

        const conditions: Array<{
            column: string;
            op: "eq" | "in";
            paramCount: number;
        }> = [];

        const whereMatch = sql.match(/WHERE\s+(.+)$/i);
        if (whereMatch) {
            const whereClause = whereMatch[1].trim();
            const parts = whereClause.split(/\s+AND\s+/i);
            for (const part of parts) {
                const inMatch = part.match(/(\w+)\s+IN\s*\(([^)]+)\)/i);
                if (inMatch) {
                    const column = inMatch[1];
                    const placeholders = inMatch[2]
                        .split(",")
                        .map((s) => s.trim());
                    conditions.push({
                        column,
                        op: "in",
                        paramCount: placeholders.length,
                    });
                    continue;
                }
                const eqMatch = part.match(/(\w+)\s*=\s*\?/i);
                if (eqMatch) {
                    conditions.push({
                        column: eqMatch[1],
                        op: "eq",
                        paramCount: 1,
                    });
                }
            }
        }

        return { table, conditions };
    }

    function parseDelete(sql: string): {
        table: string;
        conditions: Array<{
            column: string;
            op: "eq" | "in";
            paramCount: number;
        }>;
    } {
        const match = sql.match(/DELETE\s+FROM\s+(\w+)/i);
        if (!match) throw new Error(`Cannot parse DELETE: ${sql}`);
        const table = match[1];

        const conditions: Array<{
            column: string;
            op: "eq" | "in";
            paramCount: number;
        }> = [];

        const whereMatch = sql.match(/WHERE\s+(.+)$/i);
        if (whereMatch) {
            const eqMatch = whereMatch[1].match(/(\w+)\s*=\s*\?/i);
            if (eqMatch) {
                conditions.push({
                    column: eqMatch[1],
                    op: "eq",
                    paramCount: 1,
                });
            }
        }

        return { table, conditions };
    }

    function getTable(name: string): TableDef {
        const t = tables.get(name);
        if (!t) throw new Error(`Table ${name} does not exist`);
        return t;
    }

    function rowKey(pk: string[], row: Record<string, unknown>): string {
        return pk.map((col) => String(row[col] ?? "")).join("\x00");
    }

    function matchesConditions(
        row: Record<string, unknown>,
        conditions: Array<{
            column: string;
            op: "eq" | "in";
            paramCount: number;
        }>,
        params: unknown[]
    ): boolean {
        let paramIdx = 0;
        for (const cond of conditions) {
            if (cond.op === "eq") {
                if (row[cond.column] !== params[paramIdx]) return false;
                paramIdx += 1;
            } else {
                // in
                const values = params.slice(
                    paramIdx,
                    paramIdx + cond.paramCount
                );
                if (!values.includes(row[cond.column])) return false;
                paramIdx += cond.paramCount;
            }
        }
        return true;
    }

    const executor: SQLExecutor = {
        async run(sql: string, params?: unknown[]): Promise<void> {
            const trimmed = sql.trim();

            if (/^CREATE\s+TABLE/i.test(trimmed)) {
                const { name, pk } = parseCreateTable(trimmed);
                if (!tables.has(name)) {
                    tables.set(name, { primaryKey: pk, rows: new Map() });
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
                const key = rowKey(t.primaryKey, row);
                t.rows.set(key, row);
                return;
            }

            if (/^DELETE/i.test(trimmed)) {
                const { table, conditions } = parseDelete(trimmed);
                const t = getTable(table);
                if (conditions.length === 0) {
                    t.rows.clear();
                } else {
                    for (const [key, row] of t.rows) {
                        if (matchesConditions(row, conditions, params ?? [])) {
                            t.rows.delete(key);
                        }
                    }
                }
                return;
            }

            if (/^CREATE\s+INDEX/i.test(trimmed)) {
                // no-op for in-memory mock
                return;
            }

            throw new Error(`Unsupported SQL in run(): ${trimmed}`);
        },

        async get<T = Record<string, unknown>>(
            sql: string,
            params?: unknown[]
        ): Promise<T | undefined> {
            const trimmed = sql.trim();
            const { table, conditions } = parseSelect(trimmed);
            const t = getTable(table);

            if (conditions.length === 0) {
                const first = t.rows.values().next();
                return first.done ? undefined : (first.value as T);
            }

            for (const row of t.rows.values()) {
                if (matchesConditions(row, conditions, params ?? [])) {
                    return row as T;
                }
            }
            return undefined;
        },

        async all<T = Record<string, unknown>>(
            sql: string,
            params?: unknown[]
        ): Promise<T[]> {
            const trimmed = sql.trim();
            const { table, conditions } = parseSelect(trimmed);
            const t = getTable(table);

            const results: Record<string, unknown>[] = [];

            if (conditions.length === 0) {
                results.push(...Array.from(t.rows.values()));
            } else {
                for (const row of t.rows.values()) {
                    if (matchesConditions(row, conditions, params ?? [])) {
                        results.push(row);
                    }
                }
            }

            return results as T[];
        },
    };

    return executor;
}

// ── Test fixtures ───────────────────────────────────────────────────────

function createMockContract(overrides: Partial<Contract> = {}): Contract {
    return {
        script: "5120abcdef",
        address: "tark1abc",
        type: "default",
        state: "active" as ContractState,
        params: { key1: "value1" },
        createdAt: 1704067200000,
        ...overrides,
    };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("SQLiteContractRepository", () => {
    let db: SQLExecutor;
    let repository: SQLiteContractRepository;

    beforeEach(() => {
        db = createMockSQLExecutor();
        repository = new SQLiteContractRepository(db);
    });

    afterEach(async () => {
        await repository.clear();
        await repository[Symbol.asyncDispose]();
    });

    // ── version ────────────────────────────────────────────────────────

    it("should have version 1", () => {
        expect(repository.version).toBe(1);
    });

    // ── Save and retrieve ──────────────────────────────────────────────

    describe("save and retrieve contracts", () => {
        it("should save and retrieve contracts (no filter)", async () => {
            const contract1 = createMockContract({
                script: "script1",
                address: "addr1",
            });
            const contract2 = createMockContract({
                script: "script2",
                address: "addr2",
                type: "vhtlc",
                state: "inactive",
            });

            await repository.saveContract(contract1);
            await repository.saveContract(contract2);

            const retrieved = await repository.getContracts();
            expect(retrieved).toHaveLength(2);

            const scripts = retrieved.map((c) => c.script).sort();
            expect(scripts).toEqual(["script1", "script2"]);
        });

        it("should round-trip all contract fields including optionals", async () => {
            const contract = createMockContract({
                script: "script-full",
                address: "addr-full",
                type: "vhtlc",
                state: "active",
                params: { sender: "ab12", receiver: "cd34", hash: "1234" },
                createdAt: 1704067200000,
                expiresAt: 1704153600000,
                label: "My VHTLC",
                metadata: { boltzId: "swap-123", nested: { a: 1 } },
            });

            await repository.saveContract(contract);
            const [retrieved] = await repository.getContracts();

            expect(retrieved.script).toBe("script-full");
            expect(retrieved.address).toBe("addr-full");
            expect(retrieved.type).toBe("vhtlc");
            expect(retrieved.state).toBe("active");
            expect(retrieved.params).toEqual({
                sender: "ab12",
                receiver: "cd34",
                hash: "1234",
            });
            expect(retrieved.createdAt).toBe(1704067200000);
            expect(retrieved.expiresAt).toBe(1704153600000);
            expect(retrieved.label).toBe("My VHTLC");
            expect(retrieved.metadata).toEqual({
                boltzId: "swap-123",
                nested: { a: 1 },
            });
        });

        it("should not set optional fields when they are null/absent", async () => {
            const contract = createMockContract({
                script: "script-minimal",
                // no expiresAt, no label, no metadata
            });

            await repository.saveContract(contract);
            const [retrieved] = await repository.getContracts();

            expect(retrieved.expiresAt).toBeUndefined();
            expect(retrieved.label).toBeUndefined();
            expect(retrieved.metadata).toBeUndefined();
        });
    });

    // ── Filter by state ────────────────────────────────────────────────

    describe("filter by state", () => {
        it("should filter by single state", async () => {
            await repository.saveContract(
                createMockContract({
                    script: "s1",
                    state: "active",
                })
            );
            await repository.saveContract(
                createMockContract({
                    script: "s2",
                    state: "inactive",
                })
            );
            await repository.saveContract(
                createMockContract({
                    script: "s3",
                    state: "active",
                })
            );

            const active = await repository.getContracts({ state: "active" });
            expect(active).toHaveLength(2);
            expect(active.every((c) => c.state === "active")).toBe(true);

            const inactive = await repository.getContracts({
                state: "inactive",
            });
            expect(inactive).toHaveLength(1);
            expect(inactive[0].script).toBe("s2");
        });

        it("should filter by state array", async () => {
            await repository.saveContract(
                createMockContract({ script: "s1", state: "active" })
            );
            await repository.saveContract(
                createMockContract({ script: "s2", state: "inactive" })
            );

            const both = await repository.getContracts({
                state: ["active", "inactive"],
            });
            expect(both).toHaveLength(2);
        });
    });

    // ── Filter by type ─────────────────────────────────────────────────

    describe("filter by type", () => {
        it("should filter by single type", async () => {
            await repository.saveContract(
                createMockContract({ script: "s1", type: "default" })
            );
            await repository.saveContract(
                createMockContract({ script: "s2", type: "vhtlc" })
            );
            await repository.saveContract(
                createMockContract({ script: "s3", type: "vhtlc" })
            );

            const vhtlc = await repository.getContracts({ type: "vhtlc" });
            expect(vhtlc).toHaveLength(2);
            expect(vhtlc.every((c) => c.type === "vhtlc")).toBe(true);
        });

        it("should filter by type array", async () => {
            await repository.saveContract(
                createMockContract({ script: "s1", type: "default" })
            );
            await repository.saveContract(
                createMockContract({ script: "s2", type: "vhtlc" })
            );
            await repository.saveContract(
                createMockContract({ script: "s3", type: "custom" })
            );

            const filtered = await repository.getContracts({
                type: ["default", "vhtlc"],
            });
            expect(filtered).toHaveLength(2);
            expect(filtered.map((c) => c.type).sort()).toEqual([
                "default",
                "vhtlc",
            ]);
        });
    });

    // ── Filter by script ───────────────────────────────────────────────

    describe("filter by script", () => {
        it("should filter by single script", async () => {
            await repository.saveContract(createMockContract({ script: "s1" }));
            await repository.saveContract(createMockContract({ script: "s2" }));

            const result = await repository.getContracts({ script: "s1" });
            expect(result).toHaveLength(1);
            expect(result[0].script).toBe("s1");
        });

        it("should filter by script array", async () => {
            await repository.saveContract(createMockContract({ script: "s1" }));
            await repository.saveContract(createMockContract({ script: "s2" }));
            await repository.saveContract(createMockContract({ script: "s3" }));

            const result = await repository.getContracts({
                script: ["s1", "s3"],
            });
            expect(result).toHaveLength(2);
            expect(result.map((c) => c.script).sort()).toEqual(["s1", "s3"]);
        });

        it("should return empty array when script does not exist", async () => {
            await repository.saveContract(createMockContract({ script: "s1" }));

            const result = await repository.getContracts({
                script: "nonexistent",
            });
            expect(result).toEqual([]);
        });
    });

    // ── Combined filters ───────────────────────────────────────────────

    describe("combined filters (state + type)", () => {
        it("should filter by state AND type", async () => {
            await repository.saveContract(
                createMockContract({
                    script: "s1",
                    state: "active",
                    type: "default",
                })
            );
            await repository.saveContract(
                createMockContract({
                    script: "s2",
                    state: "active",
                    type: "vhtlc",
                })
            );
            await repository.saveContract(
                createMockContract({
                    script: "s3",
                    state: "inactive",
                    type: "vhtlc",
                })
            );

            const result = await repository.getContracts({
                state: "active",
                type: "vhtlc",
            });
            expect(result).toHaveLength(1);
            expect(result[0].script).toBe("s2");
        });

        it("should filter by state AND type with arrays", async () => {
            await repository.saveContract(
                createMockContract({
                    script: "s1",
                    state: "active",
                    type: "default",
                })
            );
            await repository.saveContract(
                createMockContract({
                    script: "s2",
                    state: "active",
                    type: "vhtlc",
                })
            );
            await repository.saveContract(
                createMockContract({
                    script: "s3",
                    state: "inactive",
                    type: "vhtlc",
                })
            );
            await repository.saveContract(
                createMockContract({
                    script: "s4",
                    state: "inactive",
                    type: "custom",
                })
            );

            const result = await repository.getContracts({
                state: ["active", "inactive"],
                type: "vhtlc",
            });
            expect(result).toHaveLength(2);
            expect(result.map((c) => c.script).sort()).toEqual(["s2", "s3"]);
        });
    });

    // ── Delete by script ───────────────────────────────────────────────

    describe("delete by script", () => {
        it("should delete a contract by script", async () => {
            await repository.saveContract(createMockContract({ script: "s1" }));
            await repository.saveContract(createMockContract({ script: "s2" }));

            await repository.deleteContract("s1");

            const remaining = await repository.getContracts();
            expect(remaining).toHaveLength(1);
            expect(remaining[0].script).toBe("s2");
        });

        it("should not throw when deleting non-existent script", async () => {
            await expect(
                repository.deleteContract("nonexistent")
            ).resolves.toBeUndefined();
        });
    });

    // ── Upsert ─────────────────────────────────────────────────────────

    describe("upsert on save", () => {
        it("should update existing contract when saving with same script", async () => {
            const original = createMockContract({
                script: "s1",
                state: "active",
                label: "Original",
            });
            await repository.saveContract(original);

            const updated = createMockContract({
                script: "s1",
                state: "inactive",
                label: "Updated",
            });
            await repository.saveContract(updated);

            const contracts = await repository.getContracts();
            expect(contracts).toHaveLength(1);
            expect(contracts[0].state).toBe("inactive");
            expect(contracts[0].label).toBe("Updated");
        });
    });

    // ── Clear ──────────────────────────────────────────────────────────

    describe("clear all contracts", () => {
        it("should remove all contracts", async () => {
            await repository.saveContract(createMockContract({ script: "s1" }));
            await repository.saveContract(createMockContract({ script: "s2" }));
            await repository.saveContract(createMockContract({ script: "s3" }));

            await repository.clear();

            const contracts = await repository.getContracts();
            expect(contracts).toEqual([]);
        });
    });

    // ── Table prefix ───────────────────────────────────────────────────

    describe("table prefix", () => {
        it("should use custom prefix for table names", async () => {
            const customRepo = new SQLiteContractRepository(db, {
                prefix: "myapp_",
            });
            await customRepo.saveContract(
                createMockContract({ script: "s-custom" })
            );

            const retrieved = await customRepo.getContracts();
            expect(retrieved).toHaveLength(1);
            expect(retrieved[0].script).toBe("s-custom");
        });

        it("should isolate data between different prefixes", async () => {
            const repoA = new SQLiteContractRepository(db, { prefix: "a_" });
            const repoB = new SQLiteContractRepository(db, { prefix: "b_" });

            await repoA.saveContract(
                createMockContract({ script: "s-a", address: "addr-a" })
            );
            await repoB.saveContract(
                createMockContract({ script: "s-b", address: "addr-b" })
            );

            const fromA = await repoA.getContracts();
            const fromB = await repoB.getContracts();

            expect(fromA).toHaveLength(1);
            expect(fromA[0].script).toBe("s-a");
            expect(fromB).toHaveLength(1);
            expect(fromB[0].script).toBe("s-b");
        });
    });

    // ── asyncDispose ───────────────────────────────────────────────────

    describe("[Symbol.asyncDispose]", () => {
        it("should be a no-op and not throw", async () => {
            await expect(
                repository[Symbol.asyncDispose]()
            ).resolves.toBeUndefined();
        });
    });
});
