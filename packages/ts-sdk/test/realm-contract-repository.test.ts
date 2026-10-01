import { createMockRealm as mockRealm } from "../../../config/test-helpers/mockRealm";
import { collectContracts } from "../src/repositories/contractRepository";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RealmContractRepository } from "../src/repositories/realm/contractRepository";
import type { Contract, ContractState } from "../src/contracts/types";

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
    let realm: ReturnType<typeof mockRealm>;
    let repository: RealmContractRepository;

    beforeEach(() => {
        realm = mockRealm({
            ArkVtxo: "pk",
            ArkUtxo: "pk",
            ArkTransaction: "pk",
            ArkWalletState: "key",
            ArkContract: "script",
        });
        repository = new RealmContractRepository(realm);
    });

    afterEach(async () => {
        await repository.clear();
        await repository[Symbol.asyncDispose]();
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

            const retrieved = await collectContracts(repository);
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
                label: "My VHTLC",
                metadata: { boltzId: "swap-123", nested: { a: 1 } },
            });

            await repository.saveContract(contract);
            const [retrieved] = await collectContracts(repository);

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
            expect(retrieved.label).toBe("My VHTLC");
            expect(retrieved.metadata).toEqual({
                boltzId: "swap-123",
                nested: { a: 1 },
            });
        });

        it("should not set optional fields when they are null/absent", async () => {
            const contract = createMockContract({
                script: "script-minimal",
                // no label, no metadata
            });

            await repository.saveContract(contract);
            const [retrieved] = await collectContracts(repository);

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
                }),
            );
            await repository.saveContract(
                createMockContract({
                    script: "s2",
                    state: "inactive",
                }),
            );
            await repository.saveContract(
                createMockContract({
                    script: "s3",
                    state: "active",
                }),
            );

            const active = await collectContracts(repository, { state: "active" });
            expect(active).toHaveLength(2);
            expect(active.every((c) => c.state === "active")).toBe(true);

            const inactive = await collectContracts(repository, {
                state: "inactive",
            });
            expect(inactive).toHaveLength(1);
            expect(inactive[0].script).toBe("s2");
        });

        it("should filter by state array", async () => {
            await repository.saveContract(createMockContract({ script: "s1", state: "active" }));
            await repository.saveContract(createMockContract({ script: "s2", state: "inactive" }));

            const both = await collectContracts(repository, {
                state: ["active", "inactive"],
            });
            expect(both).toHaveLength(2);
        });
    });

    // ── Filter by type ─────────────────────────────────────────────────

    describe("filter by type", () => {
        it("should filter by single type", async () => {
            await repository.saveContract(createMockContract({ script: "s1", type: "default" }));
            await repository.saveContract(createMockContract({ script: "s2", type: "vhtlc" }));
            await repository.saveContract(createMockContract({ script: "s3", type: "vhtlc" }));

            const vhtlc = await collectContracts(repository, { type: "vhtlc" });
            expect(vhtlc).toHaveLength(2);
            expect(vhtlc.every((c) => c.type === "vhtlc")).toBe(true);
        });

        it("should filter by type array", async () => {
            await repository.saveContract(createMockContract({ script: "s1", type: "default" }));
            await repository.saveContract(createMockContract({ script: "s2", type: "vhtlc" }));
            await repository.saveContract(createMockContract({ script: "s3", type: "custom" }));

            const filtered = await collectContracts(repository, {
                type: ["default", "vhtlc"],
            });
            expect(filtered).toHaveLength(2);
            expect(filtered.map((c) => c.type).sort()).toEqual(["default", "vhtlc"]);
        });
    });

    // ── Watch state ────────────────────────────────────────────────────

    describe("watch state", () => {
        it("round-trips the watch state", async () => {
            await repository.saveContract(createMockContract({ script: "s1", watch: "retained" }));
            await repository.saveContract(
                createMockContract({ script: "s2", watch: "awaiting-funds" }),
            );

            expect((await collectContracts(repository, { script: "s1" }))[0].watch).toBe(
                "retained",
            );
            expect((await collectContracts(repository, { script: "s2" }))[0].watch).toBe(
                "awaiting-funds",
            );
        });

        it("filters by watch state, counting rows without one as watched", async () => {
            // A contract saved before the property existed — the shape
            // every deployed row has.
            await repository.saveContract(createMockContract({ script: "legacy" }));
            await repository.saveContract(createMockContract({ script: "s1", watch: "watched" }));
            await repository.saveContract(createMockContract({ script: "s2", watch: "retained" }));

            const watched = await collectContracts(repository, { watch: "watched" });
            expect(watched.map((c) => c.script).sort()).toEqual(["legacy", "s1"]);

            const retained = await collectContracts(repository, { watch: "retained" });
            expect(retained.map((c) => c.script)).toEqual(["s2"]);
        });
    });

    // ── Filter by script ───────────────────────────────────────────────

    describe("filter by script", () => {
        it("should filter by single script", async () => {
            await repository.saveContract(createMockContract({ script: "s1" }));
            await repository.saveContract(createMockContract({ script: "s2" }));

            const result = await collectContracts(repository, { script: "s1" });
            expect(result).toHaveLength(1);
            expect(result[0].script).toBe("s1");
        });

        it("should filter by script array", async () => {
            await repository.saveContract(createMockContract({ script: "s1" }));
            await repository.saveContract(createMockContract({ script: "s2" }));
            await repository.saveContract(createMockContract({ script: "s3" }));

            const result = await collectContracts(repository, {
                script: ["s1", "s3"],
            });
            expect(result).toHaveLength(2);
            expect(result.map((c) => c.script).sort()).toEqual(["s1", "s3"]);
        });

        it("should return empty array when script does not exist", async () => {
            await repository.saveContract(createMockContract({ script: "s1" }));

            const result = await collectContracts(repository, {
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
                }),
            );
            await repository.saveContract(
                createMockContract({
                    script: "s2",
                    state: "active",
                    type: "vhtlc",
                }),
            );
            await repository.saveContract(
                createMockContract({
                    script: "s3",
                    state: "inactive",
                    type: "vhtlc",
                }),
            );

            const result = await collectContracts(repository, {
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
                }),
            );
            await repository.saveContract(
                createMockContract({
                    script: "s2",
                    state: "active",
                    type: "vhtlc",
                }),
            );
            await repository.saveContract(
                createMockContract({
                    script: "s3",
                    state: "inactive",
                    type: "vhtlc",
                }),
            );
            await repository.saveContract(
                createMockContract({
                    script: "s4",
                    state: "inactive",
                    type: "custom",
                }),
            );

            const result = await collectContracts(repository, {
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

            const remaining = await collectContracts(repository);
            expect(remaining).toHaveLength(1);
            expect(remaining[0].script).toBe("s2");
        });

        it("should not throw when deleting non-existent script", async () => {
            await expect(repository.deleteContract("nonexistent")).resolves.toBeUndefined();
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

            const contracts = await collectContracts(repository);
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

            const contracts = await collectContracts(repository);
            expect(contracts).toEqual([]);
        });
    });
});
