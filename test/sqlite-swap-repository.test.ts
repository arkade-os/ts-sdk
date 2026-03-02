import { describe, it, expect, beforeEach } from "vitest";
import { SQLiteSwapRepository } from "../src/repositories/sqlite/swap-repository";
import type { SQLExecutor } from "@arkade-os/sdk/repositories/sqlite";
import type {
    PendingReverseSwap,
    PendingSubmarineSwap,
    PendingChainSwap,
} from "../src/types";

// ── Mock SQLExecutor ────────────────────────────────────────────────────

/**
 * Lightweight in-memory SQL mock that supports the subset of SQL used by
 * SQLiteSwapRepository:
 *   - CREATE TABLE IF NOT EXISTS
 *   - CREATE INDEX IF NOT EXISTS (no-op)
 *   - INSERT OR REPLACE INTO ... VALUES (?, ?, ...)
 *   - SELECT <cols> FROM <table> [WHERE ...] [ORDER BY ...]
 *   - DELETE FROM <table> [WHERE id = ?]
 *   - DELETE FROM <table>
 */
function createMockExecutor(): SQLExecutor {
    // tableName -> Map<primaryKey, Record<columnName, unknown>>
    const tables = new Map<string, Map<string, Record<string, unknown>>>();

    function getTable(name: string): Map<string, Record<string, unknown>> {
        let table = tables.get(name);
        if (!table) {
            table = new Map();
            tables.set(name, table);
        }
        return table;
    }

    return {
        async run(sql: string, params?: unknown[]): Promise<void> {
            const trimmed = sql.trim();

            // CREATE TABLE IF NOT EXISTS
            if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(trimmed)) {
                const match = trimmed.match(
                    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i
                );
                if (match) getTable(match[1]);
                return;
            }

            // CREATE INDEX — no-op
            if (/^CREATE\s+INDEX/i.test(trimmed)) return;

            // INSERT OR REPLACE INTO <table> (<cols>) VALUES (?, ?, ...)
            const insertMatch = trimmed.match(
                /INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i
            );
            if (insertMatch) {
                const tableName = insertMatch[1];
                const cols = insertMatch[2].split(",").map((c) => c.trim());
                const table = getTable(tableName);
                const row: Record<string, unknown> = {};
                for (let i = 0; i < cols.length; i++) {
                    row[cols[i]] = params?.[i];
                }
                // primary key is first column
                table.set(String(row[cols[0]]), row);
                return;
            }

            // DELETE FROM <table> WHERE id = ?
            const deleteWhereMatch = trimmed.match(
                /DELETE\s+FROM\s+(\w+)\s+WHERE\s+id\s*=\s*\?/i
            );
            if (deleteWhereMatch) {
                const table = getTable(deleteWhereMatch[1]);
                table.delete(String(params?.[0]));
                return;
            }

            // DELETE FROM <table>  (clear all)
            const deleteAllMatch = trimmed.match(/DELETE\s+FROM\s+(\w+)/i);
            if (deleteAllMatch) {
                const table = getTable(deleteAllMatch[1]);
                table.clear();
                return;
            }
        },

        async get<T = Record<string, unknown>>(
            sql: string,
            params?: unknown[]
        ): Promise<T | undefined> {
            const rows = await this.all<T>(sql, params);
            return rows[0];
        },

        async all<T = Record<string, unknown>>(
            sql: string,
            params?: unknown[]
        ): Promise<T[]> {
            const trimmed = sql.trim();

            // Parse: SELECT <cols> FROM <table> [WHERE ...] [ORDER BY ...]
            const selectMatch = trimmed.match(
                /SELECT\s+(.+?)\s+FROM\s+(\w+)(.*)/is
            );
            if (!selectMatch) return [];

            const colsPart = selectMatch[1].trim();
            const tableName = selectMatch[2];
            const rest = selectMatch[3].trim();

            const table = getTable(tableName);
            let rows = Array.from(table.values());

            // Parse WHERE clause
            const whereMatch = rest.match(
                /WHERE\s+(.+?)(?:\s+ORDER\s+BY\s+|$)/is
            );
            if (whereMatch) {
                const whereClause = whereMatch[1].trim();
                // Split on AND
                const conditions = whereClause
                    .split(/\s+AND\s+/i)
                    .map((c) => c.trim());

                let paramIdx = 0;
                for (const cond of conditions) {
                    // col IN (?, ?, ...)
                    const inMatch = cond.match(/(\w+)\s+IN\s*\(([^)]+)\)/i);
                    if (inMatch) {
                        const col = inMatch[1];
                        const placeholders = inMatch[2]
                            .split(",")
                            .map((p) => p.trim());
                        const values = placeholders.map(
                            () => params?.[paramIdx++]
                        );
                        rows = rows.filter((r) =>
                            values.includes(r[col] as any)
                        );
                        continue;
                    }

                    // col = ?
                    const eqMatch = cond.match(/(\w+)\s*=\s*\?/);
                    if (eqMatch) {
                        const col = eqMatch[1];
                        const val = params?.[paramIdx++];
                        rows = rows.filter((r) => r[col] === val);
                        continue;
                    }
                }
            }

            // Parse ORDER BY
            const orderMatch = rest.match(
                /ORDER\s+BY\s+(\w+)\s+(ASC|DESC)/i
            );
            if (orderMatch) {
                const col = orderMatch[1];
                const dir = orderMatch[2].toUpperCase();
                rows.sort((a, b) => {
                    const aVal = a[col] as number;
                    const bVal = b[col] as number;
                    return dir === "ASC" ? aVal - bVal : bVal - aVal;
                });
            }

            // Project columns
            const requestedCols =
                colsPart === "*"
                    ? null
                    : colsPart.split(",").map((c) => c.trim());

            return rows.map((row) => {
                if (!requestedCols) return row as T;
                const projected: Record<string, unknown> = {};
                for (const col of requestedCols) {
                    projected[col] = row[col];
                }
                return projected as T;
            });
        },
    };
}

// ── Test Fixture Factories ──────────────────────────────────────────────

const createReverseSwap = (
    id: string,
    status: PendingReverseSwap["status"]
): PendingReverseSwap => ({
    id,
    type: "reverse",
    createdAt: Date.now() / 1000,
    preimage: "0".repeat(64),
    status,
    request: {
        claimPublicKey: "0".repeat(66),
        invoiceAmount: 10000,
        preimageHash: "0".repeat(64),
    },
    response: {
        id,
        invoice: "lnbc100n1p0",
        onchainAmount: 10000,
        lockupAddress: "ark1test",
        refundPublicKey: "0".repeat(66),
        timeoutBlockHeights: {
            refund: 100,
            unilateralClaim: 200,
            unilateralRefund: 300,
            unilateralRefundWithoutReceiver: 400,
        },
    },
});

const createSubmarineSwap = (
    id: string,
    status: PendingSubmarineSwap["status"]
): PendingSubmarineSwap => ({
    id,
    type: "submarine",
    createdAt: Date.now() / 1000,
    status,
    request: {
        invoice: "lnbc100n1p0",
        refundPublicKey: "0".repeat(66),
    },
    response: {
        id,
        address: "ark1test",
        expectedAmount: 10000,
        claimPublicKey: "0".repeat(66),
        acceptZeroConf: false,
        timeoutBlockHeights: {
            refund: 100,
            unilateralClaim: 200,
            unilateralRefund: 300,
            unilateralRefundWithoutReceiver: 400,
        },
    },
});

const createChainSwap = (
    id: string,
    status: PendingChainSwap["status"],
    overrides?: Partial<PendingChainSwap>
): PendingChainSwap => ({
    id,
    type: "chain",
    createdAt: Date.now() / 1000,
    preimage: "0".repeat(64),
    ephemeralKey: "0".repeat(64),
    feeSatsPerByte: 2,
    status,
    amount: 50000,
    request: {
        to: "BTC",
        from: "ARK",
        preimageHash: "0".repeat(64),
        claimPublicKey: "0".repeat(66),
        feeSatsPerByte: 2,
        refundPublicKey: "0".repeat(66),
    },
    response: {
        id,
        claimDetails: {
            amount: 49500,
            lockupAddress: "bc1qtest",
            timeoutBlockHeight: 800000,
            serverPublicKey: "0".repeat(66),
        },
        lockupDetails: {
            amount: 50000,
            lockupAddress: "ark1lockup",
            timeoutBlockHeight: 800100,
            serverPublicKey: "0".repeat(66),
        },
    },
    ...overrides,
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("SQLiteSwapRepository", () => {
    let repo: SQLiteSwapRepository;

    beforeEach(() => {
        const executor = createMockExecutor();
        repo = new SQLiteSwapRepository(executor);
    });

    it("saves and retrieves swaps", async () => {
        const reverse = createReverseSwap("reverse-1", "swap.created");
        const submarine = createSubmarineSwap("submarine-1", "invoice.set");

        await repo.saveSwap(reverse);
        await repo.saveSwap(submarine);

        const reverseSwaps = await repo.getAllSwaps({ type: "reverse" });
        const submarineSwaps = await repo.getAllSwaps({ type: "submarine" });

        expect(reverseSwaps).toHaveLength(1);
        expect(reverseSwaps[0].id).toBe("reverse-1");
        expect(submarineSwaps).toHaveLength(1);
        expect(submarineSwaps[0].id).toBe("submarine-1");
    });

    it("returns full swap data including nested objects", async () => {
        const reverse = createReverseSwap("reverse-1", "swap.created");
        await repo.saveSwap(reverse);

        const [result] = await repo.getAllSwaps<PendingReverseSwap>({
            id: "reverse-1",
        });

        expect(result).toBeDefined();
        expect(result.preimage).toBe("0".repeat(64));
        expect(result.request.claimPublicKey).toBe("0".repeat(66));
        expect(result.request.invoiceAmount).toBe(10000);
        expect(result.response.timeoutBlockHeights).toEqual({
            refund: 100,
            unilateralClaim: 200,
            unilateralRefund: 300,
            unilateralRefundWithoutReceiver: 400,
        });
    });

    it("filters by id (single)", async () => {
        await repo.saveSwap(createReverseSwap("a", "swap.created"));
        await repo.saveSwap(createReverseSwap("b", "swap.created"));

        const result = await repo.getAllSwaps({ id: "b" });

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("b");
    });

    it("filters by id (array)", async () => {
        await repo.saveSwap(createReverseSwap("a", "swap.created"));
        await repo.saveSwap(createReverseSwap("b", "swap.created"));
        await repo.saveSwap(createReverseSwap("c", "swap.created"));

        const result = await repo.getAllSwaps({ id: ["a", "c"] });

        expect(result).toHaveLength(2);
        expect(result.map((s) => s.id).sort()).toEqual(["a", "c"]);
    });

    it("filters by status (single)", async () => {
        await repo.saveSwap(createReverseSwap("a", "swap.created"));
        await repo.saveSwap(createReverseSwap("b", "swap.expired"));
        await repo.saveSwap(createSubmarineSwap("c", "invoice.set"));

        const result = await repo.getAllSwaps({ status: "swap.expired" });

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("b");
    });

    it("filters by status (array)", async () => {
        await repo.saveSwap(createReverseSwap("a", "swap.created"));
        await repo.saveSwap(createReverseSwap("b", "swap.expired"));
        await repo.saveSwap(createSubmarineSwap("c", "invoice.set"));

        const result = await repo.getAllSwaps({
            status: ["swap.created", "invoice.set"],
        });

        expect(result).toHaveLength(2);
        expect(result.map((s) => s.id).sort()).toEqual(["a", "c"]);
    });

    it("filters by type (single)", async () => {
        await repo.saveSwap(createReverseSwap("r1", "swap.created"));
        await repo.saveSwap(createSubmarineSwap("s1", "invoice.set"));
        await repo.saveSwap(
            createChainSwap("c1", "transaction.server.mempool")
        );

        const result = await repo.getAllSwaps({ type: "chain" });

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("c1");
    });

    it("filters by type (array)", async () => {
        await repo.saveSwap(createReverseSwap("r1", "swap.created"));
        await repo.saveSwap(createSubmarineSwap("s1", "invoice.set"));
        await repo.saveSwap(
            createChainSwap("c1", "transaction.server.mempool")
        );

        const result = await repo.getAllSwaps({
            type: ["reverse", "chain"],
        });

        expect(result).toHaveLength(2);
        expect(result.map((s) => s.id).sort()).toEqual(["c1", "r1"]);
    });

    it("combines multiple filters with AND", async () => {
        await repo.saveSwap(createReverseSwap("r1", "swap.created"));
        await repo.saveSwap(createReverseSwap("r2", "swap.expired"));
        await repo.saveSwap(createSubmarineSwap("s1", "swap.created"));

        const result = await repo.getAllSwaps({
            type: "reverse",
            status: "swap.created",
        });

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("r1");
    });

    it("orders by createdAt ascending", async () => {
        const a = createReverseSwap("a", "swap.created");
        a.createdAt = 30;
        const b = createReverseSwap("b", "swap.created");
        b.createdAt = 10;
        const c = createReverseSwap("c", "swap.created");
        c.createdAt = 20;

        await repo.saveSwap(a);
        await repo.saveSwap(b);
        await repo.saveSwap(c);

        const result = await repo.getAllSwaps({
            orderBy: "createdAt",
            orderDirection: "asc",
        });

        expect(result.map((s) => s.id)).toEqual(["b", "c", "a"]);
    });

    it("orders by createdAt descending", async () => {
        const a = createReverseSwap("a", "swap.created");
        a.createdAt = 30;
        const b = createReverseSwap("b", "swap.created");
        b.createdAt = 10;
        const c = createReverseSwap("c", "swap.created");
        c.createdAt = 20;

        await repo.saveSwap(a);
        await repo.saveSwap(b);
        await repo.saveSwap(c);

        const result = await repo.getAllSwaps({
            orderBy: "createdAt",
            orderDirection: "desc",
        });

        expect(result.map((s) => s.id)).toEqual(["a", "c", "b"]);
    });

    it("filters and orders combined", async () => {
        const r1 = createReverseSwap("r1", "swap.created");
        r1.createdAt = 30;
        const r2 = createReverseSwap("r2", "swap.created");
        r2.createdAt = 10;
        const s1 = createSubmarineSwap("s1", "invoice.set");
        s1.createdAt = 20;

        await repo.saveSwap(r1);
        await repo.saveSwap(r2);
        await repo.saveSwap(s1);

        const result = await repo.getAllSwaps({
            type: "reverse",
            orderBy: "createdAt",
            orderDirection: "asc",
        });

        expect(result).toHaveLength(2);
        expect(result.map((s) => s.id)).toEqual(["r2", "r1"]);
    });

    it("updates existing swap on re-save", async () => {
        const swap = createReverseSwap("r1", "swap.created");
        await repo.saveSwap(swap);

        swap.status = "transaction.claimed";
        await repo.saveSwap(swap);

        const result = await repo.getAllSwaps({ id: "r1" });

        expect(result).toHaveLength(1);
        expect(result[0].status).toBe("transaction.claimed");
    });

    it("deletes a swap by id", async () => {
        await repo.saveSwap(createReverseSwap("a", "swap.created"));
        await repo.saveSwap(createSubmarineSwap("b", "invoice.set"));

        await repo.deleteSwap("a");

        const result = await repo.getAllSwaps();
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("b");
    });

    it("delete is no-op for non-existent id", async () => {
        await repo.saveSwap(createReverseSwap("a", "swap.created"));

        await repo.deleteSwap("does-not-exist");

        const result = await repo.getAllSwaps();
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("a");
    });

    it("clears all swaps", async () => {
        await repo.saveSwap(createReverseSwap("a", "swap.created"));
        await repo.saveSwap(createSubmarineSwap("b", "invoice.set"));
        await repo.saveSwap(
            createChainSwap("c", "transaction.server.mempool")
        );

        await repo.clear();

        const result = await repo.getAllSwaps();
        expect(result).toHaveLength(0);
    });

    it("returns empty array when no swaps match", async () => {
        await repo.saveSwap(createReverseSwap("r1", "swap.created"));

        const result = await repo.getAllSwaps({ type: "chain" });

        expect(result).toEqual([]);
    });

    it("returns all swaps when no filter provided", async () => {
        await repo.saveSwap(createReverseSwap("a", "swap.created"));
        await repo.saveSwap(createSubmarineSwap("b", "invoice.set"));
        await repo.saveSwap(
            createChainSwap("c", "transaction.server.mempool")
        );

        const result = await repo.getAllSwaps();

        expect(result).toHaveLength(3);
    });

    it("handles chain swaps with optional fields", async () => {
        const chain = createChainSwap(
            "c1",
            "transaction.server.confirmed",
            {
                toAddress: "bc1qrecipient",
                btcTxHex: "0200000001abcdef...",
            }
        );
        await repo.saveSwap(chain);

        const [result] = await repo.getAllSwaps<PendingChainSwap>({
            id: "c1",
        });

        expect(result).toBeDefined();
        expect(result.type).toBe("chain");
        expect(result.toAddress).toBe("bc1qrecipient");
        expect(result.btcTxHex).toBe("0200000001abcdef...");
        expect(result.amount).toBe(50000);
        expect(result.response.claimDetails.amount).toBe(49500);
        expect(result.response.lockupDetails.lockupAddress).toBe("ark1lockup");
    });

    it("returns empty array for empty array filter", async () => {
        await repo.saveSwap(createReverseSwap("a", "swap.created"));
        await repo.saveSwap(createSubmarineSwap("b", "invoice.set"));

        const byId = await repo.getAllSwaps({ id: [] });
        const byStatus = await repo.getAllSwaps({ status: [] });
        const byType = await repo.getAllSwaps({ type: [] });

        expect(byId).toEqual([]);
        expect(byStatus).toEqual([]);
        expect(byType).toEqual([]);
    });

    it("implements AsyncDisposable", async () => {
        await expect(repo[Symbol.asyncDispose]()).resolves.toBeUndefined();
    });
});
