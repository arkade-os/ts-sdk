import { collectContracts } from "../../src/repositories/contractRepository";
import { describe, expect, it, vi } from "vitest";
import {
    IDBCursor as FakeIDBCursor,
    IDBIndex as FakeIDBIndex,
    IDBObjectStore as FakeIDBObjectStore,
} from "fake-indexeddb";
import { createMockRealm } from "../../../../config/test-helpers/mockRealm";
import { createNodeSQLExecutor } from "../../../../config/test-helpers/nodeSqlExecutor";
import type { Contract } from "../../src/contracts/types";
import type { ContractFilter, ContractRepository } from "../../src/repositories/contractRepository";
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

    it("matches nothing for an empty array filter", async () => {
        await using repository = create();
        await repository.saveContract({
            script: "a",
            address: "address-a",
            type: "default",
            state: "active",
            params: {},
            createdAt: 1,
        });

        for (const filter of [{ script: [] }, { state: [] }, { type: [] }, { watch: [] }]) {
            const page = await repository.getContractsPage(filter, { limit: 10 });
            expect(page.items).toEqual([]);
            expect(page.nextCursor).toBeUndefined();
        }
        expect(await collectContracts(repository, { script: [] })).toEqual([]);
    });

    it("pages a watch filter across states, a row without one counting as watched", async () => {
        await using repository = create();
        const rows: [string, string, Contract["watch"]?][] = [
            ["a", "default"],
            ["b", "default", "watched"],
            ["c", "vhtlc"],
            ["d", "default", "awaiting-funds"],
            ["e", "default", "retained"],
            ["f", "vhtlc", "awaiting-funds"],
        ];
        for (const [script, type, watch] of rows) {
            await repository.saveContract({
                script,
                address: `address-${script}`,
                type,
                state: "active",
                params: {},
                createdAt: 1,
                ...(watch && { watch }),
            });
        }
        const paged = async (filter: ContractFilter) => {
            const scripts: string[] = [];
            let after: string | undefined;
            do {
                const page = await repository.getContractsPage(filter, { limit: 2, after });
                scripts.push(...page.items.map((row) => row.script));
                after = page.nextCursor;
            } while (after !== undefined);
            return scripts;
        };

        const live: ContractFilter["watch"] = ["watched", "awaiting-funds"];
        expect(await paged({ watch: live })).toEqual(["a", "b", "c", "d", "f"]);
        expect(await paged({ type: "default", watch: live })).toEqual(["a", "b", "d"]);
        expect(await paged({ type: ["vhtlc", "default"], watch: "watched" })).toEqual([
            "a",
            "b",
            "c",
        ]);
        expect(await paged({ state: "active", watch: "awaiting-funds" })).toEqual(["d", "f"]);
        expect(await paged({ watch: "retained" })).toEqual(["e"]);
        expect(await paged({ type: "vhtlc", watch: "retained" })).toEqual([]);
        const [legacy] = (await repository.getContractsPage({ watch: "watched" }, { limit: 1 }))
            .items;
        expect(legacy).toEqual({
            script: "a",
            address: "address-a",
            type: "default",
            state: "active",
            params: {},
            createdAt: 1,
        });
    });
});

it("reads a watch filter through the IndexedDB watch indexes, never a retained row", async () => {
    await using repository = new IndexedDBContractRepository(
        `watch-contract-${crypto.randomUUID()}`,
    );
    const save = (script: string, watch?: Contract["watch"]) =>
        repository.saveContract({
            script,
            address: `address-${script}`,
            type: "default",
            state: "active",
            params: {},
            createdAt: 1,
            ...(watch && { watch }),
        });
    for (let i = 0; i < 50; i++) await save(`retained-${i}`, "retained");
    await save("a", "watched");
    await save("b", "awaiting-funds");
    await save("c");
    const scan = vi.spyOn(FakeIDBObjectStore.prototype, "openCursor");
    const seek = vi.spyOn(FakeIDBIndex.prototype, "openCursor");
    const step = vi.spyOn(FakeIDBCursor.prototype, "continue");
    try {
        for (const [filter, index] of [
            [{ watch: ["watched", "awaiting-funds"] }, "watchState"],
            [{ type: "default", watch: ["watched", "awaiting-funds"] }, "typeWatchState"],
        ] as const) {
            seek.mockClear();
            step.mockClear();
            const rows = await collectContracts(repository, filter as ContractFilter);
            expect(rows.map((contract) => contract.script)).toEqual(["a", "b", "c"]);
            expect(seek.mock.contexts.map((source) => (source as IDBIndex).name)).toEqual([
                index,
                index,
            ]);
            // One step per live row; walking the store would take 53.
            expect(step.mock.calls.length).toBeLessThanOrEqual(3);
        }
        expect(scan).not.toHaveBeenCalled();
    } finally {
        scan.mockRestore();
        seek.mockRestore();
        step.mockRestore();
    }
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
