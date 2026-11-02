import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBObjectStore as FakeIDBObjectStore } from "fake-indexeddb";
import { InMemoryWalletRepository } from "../src/repositories/inMemory/walletRepository";
import { IndexedDBWalletRepository } from "../src/repositories/indexedDB/walletRepository";
import { SQLiteWalletRepository } from "../src/repositories/sqlite/walletRepository";
import { RealmWalletRepository } from "../src/repositories/realm/walletRepository";
import type { WalletRepository, WalletState } from "../src/repositories/walletRepository";
import { createNodeSQLExecutor } from "../../../config/test-helpers/nodeSqlExecutor";
import { createMockRealm } from "../../../config/test-helpers/mockRealm";
import { updateWalletState } from "../src/utils/syncCursors";

const original = (): WalletState => ({
    lastSyncTime: 12345,
    settings: { hasPendingTx: true, count: 0, nested: { keep: 7 } },
});
const increment = (state: WalletState): WalletState => ({
    ...state,
    settings: { ...state.settings, count: (state.settings?.count ?? 0) + 1 },
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

function idb(name = `atomic-state-${crypto.randomUUID()}`) {
    const repo = new IndexedDBWalletRepository(name);
    cleanups.push(async () => {
        await repo[Symbol.asyncDispose]();
    });
    return repo;
}

const backends = [
    { name: "InMemory", create: () => new InMemoryWalletRepository() },
    { name: "IndexedDB", create: () => idb() },
    {
        name: "SQLite (real Node SQLite)",
        create: () =>
            new SQLiteWalletRepository(createNodeSQLExecutor(), { walletStateTransactions: true }),
    },
    {
        name: "Realm (mock runtime)",
        create: () => new RealmWalletRepository(createMockRealm({ ArkWalletState: "key" })),
    },
];

describe.each(backends)("atomic wallet state: $name", ({ create }) => {
    it("supports absent state and updates once while preserving unrelated fields", async () => {
        const repo: WalletRepository = create();
        expect(repo.atomicWalletState?.version).toBe(1);
        await repo.atomicWalletState!.update(increment);
        expect((await repo.getWalletState())?.settings?.count).toBe(1);
        await repo.saveWalletState(original());
        const updater = vi.fn(increment);
        await repo.atomicWalletState!.update(updater);
        expect(updater).toHaveBeenCalledOnce();
        expect(await repo.getWalletState()).toEqual(increment(original()));
    });

    it("rolls back nested draft mutation when the updater throws and permits retry", async () => {
        const repo: WalletRepository = create();
        await repo.saveWalletState(original());
        const error = new Error("updater failed");
        const updater = vi.fn((state: WalletState): WalletState => {
            state.settings!.nested.keep = 99;
            throw error;
        });
        await expect(updateWalletState(repo, updater)).rejects.toBe(error);
        expect(updater).toHaveBeenCalledOnce();
        expect(await repo.getWalletState()).toEqual(original());
        await updateWalletState(repo, increment);
        expect(await repo.getWalletState()).toEqual(increment(original()));
    });

    it.each(["promise", "rejected promise", "thenable"])(
        "rejects a returned %s without saving",
        async (kind) => {
            const repo: WalletRepository = create();
            await repo.saveWalletState(original());
            const then = vi.fn();
            const updater = vi.fn((state: WalletState): WalletState => {
                state.settings!.nested.keep = 99;
                return (
                    kind === "promise"
                        ? Promise.resolve(state)
                        : kind === "rejected promise"
                          ? Promise.reject(new Error("async updater failed"))
                          : { then }
                ) as never;
            });
            await expect(updateWalletState(repo, updater)).rejects.toThrow(/synchronous/);
            expect(updater).toHaveBeenCalledOnce();
            expect(then).not.toHaveBeenCalled();
            expect(await repo.getWalletState()).toEqual(original());
            await updateWalletState(repo, increment);
            expect(await repo.getWalletState()).toEqual(increment(original()));
        },
    );
});

describe("atomic wallet-state backend boundaries", () => {
    it("keeps default SQLite wallet-state updates on the legacy path without BEGIN", async () => {
        const db = createNodeSQLExecutor();
        const repo = new SQLiteWalletRepository(db);
        await repo.saveWalletState(original());
        const run = vi.spyOn(db, "run");
        await updateWalletState(repo, increment);
        expect(run.mock.calls.some(([sql]) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql.trim()))).toBe(
            false,
        );
        expect(repo.atomicWalletState).toBeUndefined();
        expect(await repo.getWalletState()).toEqual(increment(original()));
    });

    it("keeps default SQLite updates compatible with an application-owned raw transaction", async () => {
        const db = createNodeSQLExecutor();
        const repo = new SQLiteWalletRepository(db);
        await repo.saveWalletState(original());
        await db.run("CREATE TABLE application_rows (id TEXT PRIMARY KEY)");
        await db.run("BEGIN IMMEDIATE");
        try {
            await db.run("INSERT INTO application_rows VALUES ('app-write')");
            await updateWalletState(repo, increment);
            await db.run("COMMIT");
        } catch (error) {
            await db.run("ROLLBACK");
            throw error;
        }
        expect(await db.all("SELECT id FROM application_rows")).toEqual([{ id: "app-write" }]);
        expect(await repo.getWalletState()).toEqual(increment(original()));
    });

    it.each(["SQLite", "IndexedDB"])(
        "serializes two %s repository instances without Web Locks",
        async (kind) => {
            vi.stubGlobal("navigator", {});
            const db = createNodeSQLExecutor();
            const name = `atomic-shared-${crypto.randomUUID()}`;
            const first =
                kind === "SQLite"
                    ? new SQLiteWalletRepository(db, { walletStateTransactions: true })
                    : idb(name);
            const second =
                kind === "SQLite"
                    ? new SQLiteWalletRepository(db, { walletStateTransactions: true })
                    : idb(name);
            await first.saveWalletState(original());
            await second.getWalletState();
            await Promise.all([
                updateWalletState(first, increment),
                updateWalletState(second, increment),
            ]);
            expect(await first.getWalletState()).toEqual(increment(increment(original())));
        },
    );

    it("reads Realm state inside write (mock structural check)", async () => {
        const realm = createMockRealm({ ArkWalletState: "key" });
        const repo = new RealmWalletRepository(realm);
        await repo.saveWalletState(original());
        let writing = false;
        vi.spyOn(realm, "write").mockImplementation((fn) => {
            writing = true;
            try {
                fn();
            } finally {
                writing = false;
            }
        });
        const objects = realm.objects.bind(realm);
        vi.spyOn(realm, "objects").mockImplementation((schema) => {
            expect(writing).toBe(true);
            return objects(schema);
        });
        await updateWalletState(repo, increment);
    });

    it("rejects an IndexedDB abort after put success and retains the original row", async () => {
        const repo = idb();
        await repo.saveWalletState(original());
        const put = FakeIDBObjectStore.prototype.put;
        vi.spyOn(FakeIDBObjectStore.prototype, "put").mockImplementationOnce(function (
            this: IDBObjectStore,
            value,
            key,
        ) {
            const request = put.call(this, value, key);
            request.addEventListener("success", () => this.transaction.abort());
            return request;
        });
        await expect(repo.atomicWalletState!.update(increment)).rejects.toThrow();
        expect(await repo.getWalletState()).toEqual(original());
        await repo.atomicWalletState!.update(increment);
        expect(await repo.getWalletState()).toEqual(increment(original()));
    });

    it("preserves cloneable in-memory values and rejects uncloneable state without fallback", async () => {
        const repo = new InMemoryWalletRepository();
        const state = { settings: { date: new Date(0), map: new Map([["a", 1n]]) } };
        await repo.saveWalletState(state);
        await updateWalletState(repo, increment);
        expect((await repo.getWalletState())?.settings).toMatchObject(state.settings);
        const uncloneable = { settings: { fn: () => 1 } };
        await repo.saveWalletState(uncloneable);
        const updater = vi.fn(increment);
        await expect(updateWalletState(repo, updater)).rejects.toThrow();
        expect(updater).not.toHaveBeenCalled();
        expect(await repo.getWalletState()).toBe(uncloneable);
    });

    it("keeps the legacy in-memory path when structuredClone is unavailable", async () => {
        vi.stubGlobal("structuredClone", undefined);
        const repo = new InMemoryWalletRepository();
        expect(repo.atomicWalletState).toBeUndefined();
        await updateWalletState(repo, increment);
        expect((await repo.getWalletState())?.settings?.count).toBe(1);
    });
});

describe("updateWalletState capability dispatch", () => {
    function legacy() {
        let saved: WalletState | null = null;
        return {
            getWalletState: vi.fn(async () => saved),
            saveWalletState: vi.fn(async (state: WalletState) => {
                saved = state;
            }),
        } as unknown as WalletRepository;
    }

    it("preserves custom repositories without a capability", async () => {
        const repo = legacy();
        await updateWalletState(repo, increment);
        expect(repo.getWalletState).toHaveBeenCalledOnce();
        expect(repo.saveWalletState).toHaveBeenCalledOnce();
        expect((await repo.getWalletState())?.settings?.count).toBe(1);
    });

    it("rejects unknown versions without invoking either write path", async () => {
        const repo = legacy();
        const update = vi.fn();
        Object.assign(repo, { atomicWalletState: { version: 2, update } });
        await expect(updateWalletState(repo, increment)).rejects.toThrow(/version/);
        expect(update).not.toHaveBeenCalled();
        expect(repo.getWalletState).not.toHaveBeenCalled();
        expect(repo.saveWalletState).not.toHaveBeenCalled();
    });

    it("does not fall back after an atomic failure and permits a subsequent update", async () => {
        const repo = legacy();
        const error = new Error("atomic storage failed");
        const update = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
        Object.assign(repo, { atomicWalletState: { version: 1, update } });
        await expect(updateWalletState(repo, increment)).rejects.toBe(error);
        await updateWalletState(repo, increment);
        expect(update).toHaveBeenCalledTimes(2);
        expect(repo.getWalletState).not.toHaveBeenCalled();
        expect(repo.saveWalletState).not.toHaveBeenCalled();
    });

    it("captures the capability before waiting on the helper queue", async () => {
        const repo = legacy();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.mocked(repo.getWalletState).mockImplementationOnce(async () => {
            await gate;
            return null;
        });
        const first = updateWalletState(repo, increment);
        await vi.waitFor(() => expect(repo.getWalletState).toHaveBeenCalledOnce());
        const update = vi.fn().mockResolvedValue(undefined);
        Object.assign(repo, { atomicWalletState: { version: 1, update } });
        const second = updateWalletState(repo, increment);
        Object.assign(repo, { atomicWalletState: undefined });
        release();
        await Promise.all([first, second]);
        expect(update).toHaveBeenCalledOnce();
        expect(repo.saveWalletState).toHaveBeenCalledOnce();
    });
});
