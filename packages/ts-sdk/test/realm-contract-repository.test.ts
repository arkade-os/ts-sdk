import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RealmContractRepository } from "../src/repositories/realm/contractRepository";
import type { Contract, ContractState } from "../src/contracts/types";

// ── Mock Realm ──────────────────────────────────────────────────────────
// A lightweight in-memory mock that simulates the Realm API surface
// used by RealmContractRepository.

function createMockRealm() {
    // schema name -> (primary key value -> object)
    const store = new Map<string, Map<string, any>>();

    // Map schema names to their PK fields
    const pkFields: Record<string, string> = {
        ArkVtxo: "pk",
        ArkUtxo: "pk",
        ArkTransaction: "pk",
        ArkWalletState: "key",
        ArkContract: "script",
    };

    function getSchemaStore(schemaName: string): Map<string, any> {
        if (!store.has(schemaName)) {
            store.set(schemaName, new Map());
        }
        return store.get(schemaName)!;
    }

    function getPk(schemaName: string, obj: any): string {
        const field = pkFields[schemaName] ?? "pk";
        return String(obj[field]);
    }

    /**
     * Parse a Realm-style filter string and evaluate it against an object.
     * Supports: `field == $N`, `AND`, `OR`, and parentheses grouping.
     */
    function matchesFilter(obj: any, query: string, args: any[]): boolean {
        const andParts = splitTopLevel(query, " AND ");
        return andParts.every((part) => {
            const trimmed = part.trim();
            // Handle OR groups like (field == $0 OR field == $1)
            if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
                const inner = trimmed.slice(1, -1);
                const orParts = inner.split(" OR ");
                return orParts.some((orPart) =>
                    evaluateCondition(obj, orPart.trim(), args)
                );
            }
            return evaluateCondition(obj, trimmed, args);
        });
    }

    function splitTopLevel(str: string, delimiter: string): string[] {
        const parts: string[] = [];
        let depth = 0;
        let current = "";
        let i = 0;
        while (i < str.length) {
            if (str[i] === "(") depth++;
            if (str[i] === ")") depth--;
            if (
                depth === 0 &&
                str.substring(i, i + delimiter.length) === delimiter
            ) {
                parts.push(current);
                current = "";
                i += delimiter.length;
                continue;
            }
            current += str[i];
            i++;
        }
        if (current) parts.push(current);
        return parts;
    }

    function evaluateCondition(
        obj: any,
        condition: string,
        args: any[]
    ): boolean {
        const match = condition.match(/(\w+)\s*==\s*\$(\d+)/);
        if (!match) return true; // skip unknown conditions
        const field = match[1];
        const argIdx = parseInt(match[2], 10);
        return obj[field] === args[argIdx];
    }

    function createFilteredResult(items: any[], schemaName: string) {
        const result: any = {
            filtered(query: string, ...args: any[]) {
                const filtered = items.filter((item) =>
                    matchesFilter(item, query, args)
                );
                return createFilteredResult(filtered, schemaName);
            },
            [Symbol.iterator]: () => items[Symbol.iterator](),
            length: items.length,
            snapshot() {
                return [...items];
            },
        };
        return result;
    }

    const realm = {
        write(callback: () => void) {
            callback();
        },

        create(schemaName: string, obj: any, mode?: string) {
            const schemaStore = getSchemaStore(schemaName);
            const pk = getPk(schemaName, obj);
            if (mode === "modified") {
                const existing = schemaStore.get(pk);
                if (existing) {
                    schemaStore.set(pk, { ...existing, ...obj });
                } else {
                    schemaStore.set(pk, { ...obj });
                }
            } else {
                schemaStore.set(pk, { ...obj });
            }
        },

        objects(schemaName: string) {
            const schemaStore = getSchemaStore(schemaName);
            const items = [...schemaStore.values()];
            return createFilteredResult(items, schemaName);
        },

        delete(objects: any) {
            const toRemove = [...objects];
            for (const [schemaName, schemaStore] of store) {
                const pkField = pkFields[schemaName] ?? "pk";
                for (const item of toRemove) {
                    const pk = String(item[pkField]);
                    if (schemaStore.has(pk)) {
                        schemaStore.delete(pk);
                    }
                }
            }
        },
    };

    return realm;
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

describe("RealmContractRepository", () => {
    let realm: ReturnType<typeof createMockRealm>;
    let repository: RealmContractRepository;

    beforeEach(() => {
        realm = createMockRealm();
        repository = new RealmContractRepository(realm);
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

    // ── asyncDispose ───────────────────────────────────────────────────

    describe("[Symbol.asyncDispose]", () => {
        it("should be a no-op and not throw", async () => {
            await expect(
                repository[Symbol.asyncDispose]()
            ).resolves.toBeUndefined();
        });
    });
});
