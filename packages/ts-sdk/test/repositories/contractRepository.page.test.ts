import { collectContracts } from "../../src/repositories/contractRepository";
import { describe, expect, it, vi } from "vitest";
import { IDBObjectStore as FakeIDBObjectStore } from "fake-indexeddb";
import { createMockRealm } from "../../../../config/test-helpers/mockRealm";
import { createNodeSQLExecutor } from "../../../../config/test-helpers/nodeSqlExecutor";
import type { Contract } from "../../src/contracts/types";
import type { ContractRepository } from "../../src/repositories/contractRepository";
import { InMemoryContractRepository } from "../../src/repositories/inMemory/contractRepository";
import { IndexedDBContractRepository } from "../../src/repositories/indexedDB/contractRepository";
import { RealmContractRepository } from "../../src/repositories/realm/contractRepository";
import { SQLiteContractRepository } from "../../src/repositories/sqlite/contractRepository";

const backends: [string, () => ContractRepository][] = [
    ["memory", () => new InMemoryContractRepository()],
    ["indexeddb", () => new IndexedDBContractRepository(`page-contract-${crypto.randomUUID()}`)],
    ["realm", () => new RealmContractRepository(createMockRealm({ ArkContract: "script" }))],
    ["sqlite", () => new SQLiteContractRepository(createNodeSQLExecutor())],
];

describe.each(backends)("contract pages (%s)", (_, create) => {
    it("filters before paging and resumes in script order", async () => {
        await using repository = create();
        for (const script of ["c", "a", "B", "b"]) {
            const contract: Contract = {
                script,
                address: `address-${script}`,
                type: "default",
                state: script === "c" ? "inactive" : "active",
                params: {},
                createdAt: 1,
            };
            await repository.saveContract(contract);
        }

        const first = await repository.getContractsPage({ state: "active" }, { limit: 2 });
        expect(first.items.map((row) => row.script)).toEqual(["B", "a"]);
        expect(first.nextCursor).toBe("a");

        const second = await repository.getContractsPage(
            { state: "active" },
            { after: first.nextCursor, limit: 2 },
        );
        expect(second.items.map((row) => row.script)).toEqual(["b"]);
        expect(second.nextCursor).toBeUndefined();
        expect(await collectContracts(repository)).toHaveLength(4);
        await expect(repository.getContractsPage(undefined, { limit: 0 })).rejects.toThrow(
            RangeError,
        );
    });
});

it("uses keyed IndexedDB reads for a script-filtered contract page", async () => {
    await using repository = new IndexedDBContractRepository(
        `keyed-contract-${crypto.randomUUID()}`,
    );
    for (const script of ["a", "b", "c"]) {
        await repository.saveContract({
            script,
            address: `address-${script}`,
            type: "default",
            state: script === "b" ? "inactive" : "active",
            params: {},
            createdAt: 1,
        });
    }
    const get = vi.spyOn(FakeIDBObjectStore.prototype, "get");
    const openCursor = vi.spyOn(FakeIDBObjectStore.prototype, "openCursor");
    try {
        const page = await repository.getContractsPage(
            { script: ["c", "a", "b", "a"], state: "active" },
            { limit: 1 },
        );
        expect(page.items.map((contract) => contract.script)).toEqual(["a"]);
        expect(page.nextCursor).toBe("a");
        expect(get).toHaveBeenCalledTimes(3);
        const next = await repository.getContractsPage(
            { script: ["c", "a", "b", "a"], state: "active" },
            { limit: 1, after: page.nextCursor },
        );
        expect(next.items.map((contract) => contract.script)).toEqual(["c"]);
        expect(next.nextCursor).toBeUndefined();
        expect(get).toHaveBeenCalledTimes(5);
        expect(openCursor).not.toHaveBeenCalled();
    } finally {
        get.mockRestore();
        openCursor.mockRestore();
    }
});
