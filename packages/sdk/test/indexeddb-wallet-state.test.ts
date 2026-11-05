import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBObjectStore as FakeIDBObjectStore } from "fake-indexeddb";
import { IndexedDBWalletRepository } from "../src/repositories/indexedDB/walletRepository";
import { promisifyRequest } from "../src/repositories/indexedDB/idbUtils";
import { DB_VERSION } from "../src/repositories/indexedDB/schema";
import { updateWalletState } from "../src/utils/syncCursors";
import type { WalletState } from "../src/repositories/walletRepository";

describe("IndexedDB wallet-state read failures", () => {
    let name: string;
    let repo: IndexedDBWalletRepository;

    beforeEach(() => {
        name = `wallet-state-${crypto.randomUUID()}`;
        repo = new IndexedDBWalletRepository(name);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await repo[Symbol.asyncDispose]();
        await promisifyRequest(indexedDB.deleteDatabase(name));
    });

    it("returns null for genuine absence and permits initial state creation", async () => {
        expect(await repo.getWalletState()).toBeNull();
        await updateWalletState(repo, (state) => ({
            ...state,
            settings: { ...state.settings, hasPendingTx: true },
        }));
        expect(await repo.getWalletState()).toEqual({ settings: { hasPendingTx: true } });
    });

    it.each([
        ["open", false],
        ["request", false],
        ["open", true],
        ["request", true],
    ] as const)(
        "preserves existing state when the %s fails and permits a healthy retry (atomic=%s)",
        async (fault, atomic) => {
            const original: WalletState = {
                lastSyncTime: 12345,
                settings: { hasPendingTx: true, vtxoCursorMigrated: true, unrelated: { keep: 7 } },
            };
            await repo.saveWalletState(original);
            await repo[Symbol.asyncDispose]();
            repo = new IndexedDBWalletRepository(name);
            if (!atomic) Object.defineProperty(repo, "atomicWalletState", { value: undefined });
            let readError: DOMException | null = null;
            if (fault === "open") {
                const open = indexedDB.open;
                vi.spyOn(indexedDB, "open").mockImplementationOnce((dbName) => {
                    const request = open.call(indexedDB, dbName, DB_VERSION - 1);
                    request.addEventListener("error", () => {
                        readError = request.error;
                    });
                    return request;
                });
            } else {
                const get = FakeIDBObjectStore.prototype.get;
                vi.spyOn(FakeIDBObjectStore.prototype, "get").mockImplementationOnce(function (
                    this: IDBObjectStore,
                    key,
                ) {
                    const request = get.call(this, key);
                    request.addEventListener("error", () => {
                        readError = request.error;
                    });
                    this.transaction.abort();
                    return request;
                });
            }
            const save = vi.spyOn(repo, "saveWalletState");
            const updater = vi.fn((state: WalletState) => ({
                ...state,
                settings: { ...state.settings, changed: true },
            }));
            const failure = await updateWalletState(repo, updater).then(
                () => undefined,
                (error: unknown) => error,
            );
            expect(readError).toBeInstanceOf(DOMException);
            expect(failure).toBe(readError);
            expect(updater).not.toHaveBeenCalled();
            expect(save).not.toHaveBeenCalled();
            expect(await repo.getWalletState()).toEqual(original);

            await updateWalletState(repo, updater);
            expect(updater).toHaveBeenCalledOnce();
            expect(save).toHaveBeenCalledTimes(atomic ? 0 : 1);
            await repo[Symbol.asyncDispose]();
            repo = new IndexedDBWalletRepository(name);
            expect(await repo.getWalletState()).toEqual({
                ...original,
                settings: { ...original.settings, changed: true },
            });
        },
    );
});
