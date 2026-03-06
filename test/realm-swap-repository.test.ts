import { describe, it, expect, beforeEach } from "vitest";
import { RealmSwapRepository } from "../src/repositories/realm/swap-repository";
import type {
    PendingReverseSwap,
    PendingSubmarineSwap,
    PendingChainSwap,
} from "../src/types";

// ── Mock Realm ──────────────────────────────────────────────────────────

/**
 * Lightweight in-memory Realm mock that supports the subset of Realm API
 * used by RealmSwapRepository:
 *   - write(fn) — calls fn synchronously
 *   - create(schemaName, obj, mode) — upserts into a Map by primary key
 *   - objects(schemaName) — returns a filterable/sortable array-like
 *   - delete(obj) — removes from store (single object or collection)
 */
function createMockRealm() {
    // schemaName -> Map<primaryKey, Record<string, unknown>>
    const store = new Map<string, Map<string, Record<string, unknown>>>();

    function getStore(name: string): Map<string, Record<string, unknown>> {
        let table = store.get(name);
        if (!table) {
            table = new Map();
            store.set(name, table);
        }
        return table;
    }

    function makeResultSet(items: Record<string, unknown>[]) {
        const arr = [...items];

        type ResultSet = Record<string, unknown>[] & {
            filtered: (query: string, ...args: unknown[]) => ResultSet;
            sorted: (field: string, reverse?: boolean) => ResultSet;
        };

        const resultSet: ResultSet = Object.assign(arr, {
            filtered(query: string, ...args: unknown[]): ResultSet {
                // Parse conditions separated by AND
                const conditions = query
                    .split(/\s+AND\s+/i)
                    .map((c) => c.trim());
                let filtered = [...arr];

                for (const cond of conditions) {
                    // field IN {$0, $1, ...}
                    const inMatch = cond.match(/(\w+)\s+IN\s+\{([^}]+)\}/i);
                    if (inMatch) {
                        const col = inMatch[1];
                        const placeholders = inMatch[2]
                            .split(",")
                            .map((p) => p.trim());
                        const values = placeholders.map((p) => {
                            const idx = parseInt(p.replace("$", ""), 10);
                            return args[idx];
                        });
                        filtered = filtered.filter((r) =>
                            values.includes(r[col])
                        );
                        continue;
                    }

                    // field == $N
                    const eqMatch = cond.match(/(\w+)\s*==\s*\$(\d+)/);
                    if (eqMatch) {
                        const col = eqMatch[1];
                        const idx = parseInt(eqMatch[2], 10);
                        const val = args[idx];
                        filtered = filtered.filter((r) => r[col] === val);
                        continue;
                    }
                }

                return makeResultSet(filtered);
            },

            sorted(
                field: string,
                reverse?: boolean
            ): Record<string, unknown>[] & {
                filtered: typeof resultSet.filtered;
                sorted: typeof resultSet.sorted;
            } {
                const sorted = [...arr].sort((a, b) => {
                    const aVal = a[field] as number;
                    const bVal = b[field] as number;
                    return reverse ? bVal - aVal : aVal - bVal;
                });
                return makeResultSet(sorted);
            },
        });

        return resultSet;
    }

    return {
        write(fn: () => void): void {
            fn();
        },

        create(
            schemaName: string,
            obj: Record<string, unknown>,
            _mode?: string
        ): void {
            const table = getStore(schemaName);
            // Primary key is "id" for BoltzSwap
            const pk = obj.id as string;
            table.set(pk, { ...obj });
        },

        objects(schemaName: string) {
            const table = getStore(schemaName);
            return makeResultSet(Array.from(table.values()));
        },

        delete(obj: Record<string, unknown> | Record<string, unknown>[]): void {
            // Handle both single objects and collections (arrays)
            const items = Array.isArray(obj) ? obj : [obj];
            for (const [schemaName, table] of store.entries()) {
                for (const item of items) {
                    const pk = item.id as string;
                    if (pk !== undefined) {
                        table.delete(pk);
                    }
                }
            }
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

describe("RealmSwapRepository", () => {
    let repo: RealmSwapRepository;

    beforeEach(() => {
        const realm = createMockRealm();
        repo = new RealmSwapRepository(realm);
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
        await repo.saveSwap(createChainSwap("c", "transaction.server.mempool"));

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
        await repo.saveSwap(createChainSwap("c", "transaction.server.mempool"));

        const result = await repo.getAllSwaps();

        expect(result).toHaveLength(3);
    });

    it("handles chain swaps with optional fields", async () => {
        const chain = createChainSwap("c1", "transaction.server.confirmed", {
            toAddress: "bc1qrecipient",
        });
        await repo.saveSwap(chain);

        const [result] = await repo.getAllSwaps<PendingChainSwap>({
            id: "c1",
        });

        expect(result).toBeDefined();
        expect(result.type).toBe("chain");
        expect(result.toAddress).toBe("bc1qrecipient");
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
