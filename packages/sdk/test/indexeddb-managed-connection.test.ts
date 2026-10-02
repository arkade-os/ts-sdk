/**
 * A connection that went away must be forgotten, at both levels: the manager's
 * name-keyed cache and the per-repository handle built on top of it.
 *
 * Caching the resolved `IDBDatabase` bricks a store until reload — the manager
 * closes on `versionchange`, and every later transaction on the cached handle
 * throws `InvalidStateError` with no path back. `close` is the same defect with
 * no explicit trigger at all: eviction or "clear site data" kills the connection
 * while both caches keep serving it.
 */
import { describe, it, expect, vi } from "vitest";
import forceCloseDatabase from "fake-indexeddb/lib/forceCloseDatabase";
import { openDatabase, closeDatabase } from "../src/repositories/indexedDB/manager";
import {
    createManagedConnection,
    ConnectionDisposedError,
} from "../src/repositories/indexedDB/managedConnection";

const STORE = "rows";
const init = (db: IDBDatabase) => {
    if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
};

/** fake-indexeddb dispatches events on the task queue. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const deleteDb = (dbName: string) =>
    new Promise<void>((resolve, reject) => {
        const del = indexedDB.deleteDatabase(dbName);
        del.onsuccess = () => resolve();
        del.onerror = () => reject(del.error);
    });

/** A real round-trip, which is what proves the handle is live rather than a
 * connection object that merely exists. */
const roundTrip = async (db: IDBDatabase, key: string) => {
    const tx = db.transaction([STORE], "readwrite");
    tx.objectStore(STORE).put(key, key);
    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
};

describe("the manager's connection cache", () => {
    it("drops an abnormally closed connection instead of serving it", async () => {
        const dbName = `mgr-close-${Math.random()}`;
        const db = await openDatabase(dbName, 1, init);
        forceCloseDatabase(db);
        await flush();

        const reopened = await openDatabase(dbName, 1, init);
        expect(reopened).not.toBe(db);
        await roundTrip(reopened, "k");
        await closeDatabase(dbName);
    });

    it("does not drop a successor's entry when a pending open fails late", async () => {
        // `closeDatabase` deletes the entry synchronously and only then awaits
        // the promise, so closing while an open is still pending lets the next
        // `openDatabase` install a successor under the same name. The failing
        // open's cleanup must not touch it — `settled` is still false, so the
        // identity check is the only thing standing between the successor and a
        // connection nothing tracks.
        const dbName = `late-failure-${Math.random()}`;
        const external = await new Promise<IDBDatabase>((resolve, reject) => {
            const open = indexedDB.open(dbName, 5);
            open.onupgradeneeded = () => init(open.result);
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
        });

        const spy = vi.spyOn(indexedDB, "open");
        try {
            // fails: v1 is below the existing v5. Its entry is installed now and
            // its onerror fires later.
            const failing = openDatabase(dbName, 1, init);
            void closeDatabase(dbName); // deletes that entry while still pending
            const successor = openDatabase(dbName, 5, init); // installs its own

            await expect(failing).rejects.toMatchObject({ name: "VersionError" });
            const db = await successor;

            // the successor is still cached: another open cache-hits it rather
            // than opening a second, untracked connection
            const opensBefore = spy.mock.calls.length;
            expect(await openDatabase(dbName, 5, init)).toBe(db);
            expect(spy.mock.calls.length).toBe(opensBefore);

            await roundTrip(db, "usable");
            await closeDatabase(dbName);
            await closeDatabase(dbName);
        } finally {
            spy.mockRestore();
            external.close();
        }
    });

    it("does not fire the close arm for its own versionchange close", async () => {
        // The two arms forget the same entry; if `close` also fired on an
        // explicit close(), the second would drop a successor's entry.
        const dbName = `mgr-both-${Math.random()}`;
        const db = await openDatabase(dbName, 1, init);
        const closes = vi.fn();
        db.addEventListener("close", closes);

        await deleteDb(dbName); // fires versionchange, manager closes
        await flush();
        expect(closes).not.toHaveBeenCalled();
    });
});

describe("a managed connection", () => {
    it("opens nothing until the first get()", async () => {
        const spy = vi.spyOn(indexedDB, "open");
        try {
            const dbName = `lazy-${Math.random()}`;
            const connection = createManagedConnection(dbName, 1, init);
            expect(spy).not.toHaveBeenCalled();

            await connection.get();
            expect(spy).toHaveBeenCalledTimes(1);
            await connection[Symbol.asyncDispose]();
        } finally {
            spy.mockRestore();
        }
    });

    it("reopens after an external delete", async () => {
        const dbName = `reopen-${Math.random()}`;
        const connection = createManagedConnection(dbName, 1, init);
        const db = await connection.get();
        await roundTrip(db, "before");

        await deleteDb(dbName);
        await flush();

        const reopened = await connection.get();
        expect(reopened).not.toBe(db);
        await roundTrip(reopened, "after");
        await connection[Symbol.asyncDispose]();
    });

    it("reopens after abnormal termination", async () => {
        const dbName = `evicted-${Math.random()}`;
        const connection = createManagedConnection(dbName, 1, init);
        const db = await connection.get();

        forceCloseDatabase(db);
        await flush();

        const reopened = await connection.get();
        expect(reopened).not.toBe(db);
        await roundTrip(reopened, "after");
        await connection[Symbol.asyncDispose]();
    });

    it("fails honestly, and repeatably, when another tab upgraded past it", async () => {
        const dbName = `newer-${Math.random()}`;
        const connection = createManagedConnection(dbName, 1, init);
        await connection.get();

        const newer = await new Promise<IDBDatabase>((resolve, reject) => {
            const open = indexedDB.open(dbName, 100);
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
        });
        await flush();
        try {
            for (const attempt of [1, 2]) {
                await expect(connection.get(), `attempt ${attempt}`).rejects.toMatchObject({
                    name: "VersionError",
                });
            }
        } finally {
            newer.close();
        }
    });

    it("throws after dispose, and disposes idempotently", async () => {
        const dbName = `disposed-${Math.random()}`;
        const connection = createManagedConnection(dbName, 1, init);
        await connection.get();

        await connection[Symbol.asyncDispose]();
        await expect(connection.get()).rejects.toBeInstanceOf(ConnectionDisposedError);
        await expect(connection[Symbol.asyncDispose]()).resolves.toBeUndefined();
    });

    it("returns without throwing when closed after a rejected open", async () => {
        // Refcount sanity: the rejection already cleared the manager's entry, so
        // dispose must not decrement whatever a successor installed.
        const dbName = `rejected-${Math.random()}`;
        const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
            const open = indexedDB.open(dbName, 5);
            open.onupgradeneeded = () => init(open.result);
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
        });
        const connection = createManagedConnection(dbName, 1, init);
        await expect(connection.get()).rejects.toMatchObject({ name: "VersionError" });
        blocker.close();
        await expect(connection[Symbol.asyncDispose]()).resolves.toBeUndefined();
    });
});

/**
 * Several repositories share one database name — wallet + contract on the
 * service-worker DB, intent + virtualTx on theirs. Each holds its own handle
 * over one manager entry, so recovery and refcounts have to work per-handle.
 */
describe("several managed connections on one name", () => {
    it("all recover after an external delete", async () => {
        const dbName = `shared-delete-${Math.random()}`;
        const first = createManagedConnection(dbName, 1, init);
        const second = createManagedConnection(dbName, 1, init);
        await first.get();
        await second.get();

        await deleteDb(dbName);
        await flush();

        await roundTrip(await first.get(), "a");
        await roundTrip(await second.get(), "b");
        await first[Symbol.asyncDispose]();
        await second[Symbol.asyncDispose]();
    });

    it("stays usable until the last one disposes, then actually closes", async () => {
        const dbName = `shared-dispose-${Math.random()}`;
        const first = createManagedConnection(dbName, 1, init);
        const second = createManagedConnection(dbName, 1, init);
        const db = await first.get();
        expect(await second.get()).toBe(db);

        await first[Symbol.asyncDispose]();
        await roundTrip(await second.get(), "still-live");

        await second[Symbol.asyncDispose]();
        // a closed connection throws InvalidStateError on `transaction`
        expect(() => db.transaction([STORE], "readonly")).toThrow();
    });
});
