export function getGlobalObject(): {
    globalObject: typeof globalThis;
} {
    if (typeof globalThis !== "undefined") {
        if (typeof globalThis.self === "object" && globalThis.self !== null) {
            return { globalObject: globalThis.self };
        }
        if (typeof globalThis.window === "object" && globalThis.window !== null) {
            return { globalObject: globalThis.window };
        }
        return { globalObject: globalThis };
    }
    throw new Error("Global object not found");
}

type DBCacheEntry = {
    version: number;
    promise: Promise<IDBDatabase>;
};

/**
 * How long a blocked upgrade waits before the open is reported as failed.
 *
 * An `IDBOpenDBRequest` that is blocked never settles on its own: it waits for
 * the other connection to close, however long that takes. A hang is worse than a
 * failure here, because the caller cannot retry what never settles.
 */
export const BLOCKED_UPGRADE_TIMEOUT_MS = 10_000;

/** A database upgrade was held open by another connection past
 * {@link BLOCKED_UPGRADE_TIMEOUT_MS}. Retryable: closing the other tab and
 * calling again is the remedy, and the bookkeeping was cleared so it can be. */
export class DatabaseUpgradeBlockedError extends Error {
    override readonly name = "DatabaseUpgradeBlockedError";
    constructor(readonly dbName: string) {
        super(
            `database "${dbName}" upgrade blocked by another connection for ` +
                `${BLOCKED_UPGRADE_TIMEOUT_MS}ms; close other tabs and retry`,
        );
    }
}

// database instance cache, avoiding multiple open requests
const dbCache = new Map<string, DBCacheEntry>();
// track reference counts for each database to avoid closing it prematurely
const refCounts = new Map<string, number>();

/**
 * Opens an IndexedDB database and increments the reference count.
 * Handles global object detection and callbacks.
 *
 * @param dbName The name of the database to open.
 * @param dbVersion The database version to open.
 * @param initDatabase A function that migrates the database schema, called
 *   on `onupgradeneeded` only. Receives the database, the previous version
 *   (0 for fresh installs), and the upgrade transaction — the transaction is
 *   required for data migrations (cursor/update on existing stores).
 *
 * @returns A promise that resolves to the database instance.
 */
export async function openDatabase(
    dbName: string,
    dbVersion: number,
    initDatabase: (db: IDBDatabase, oldVersion: number, transaction: IDBTransaction | null) => void,
): Promise<IDBDatabase> {
    const { globalObject } = getGlobalObject();
    if (!globalObject.indexedDB) {
        throw new Error("IndexedDB is not available in this environment");
    }

    // Return cached promise if available (handles concurrent calls)
    const cached = dbCache.get(dbName);
    if (cached) {
        if (cached.version !== dbVersion) {
            throw new Error(
                `Database "${dbName}" already opened with version ${cached.version}; requested ${dbVersion}`,
            );
        }
        refCounts.set(dbName, (refCounts.get(dbName) ?? 0) + 1);
        return cached.promise;
    }

    const dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = globalObject.indexedDB.open(dbName, dbVersion);
        // Rejecting on the timeout settles OUR promise and does nothing to the
        // request, which stays live and completes when the blocker closes. So
        // every handler below is gated on this: a late `onsuccess` that installed
        // `db.onversionchange` would delete the cache entry of whatever
        // connection replaced us — by name — and leave a connection nothing
        // tracks open for the page's lifetime.
        let settled = false;
        let blockedTimer: ReturnType<typeof setTimeout> | undefined;
        const clearBlockedTimer = () => {
            if (blockedTimer !== undefined) clearTimeout(blockedTimer);
            blockedTimer = undefined;
        };

        request.onerror = () => {
            clearBlockedTimer();
            if (settled) return; // the maps belong to a successor now
            settled = true;
            dbCache.delete(dbName); // Clean up on failure
            refCounts.delete(dbName);
            reject(request.error);
        };
        request.onsuccess = () => {
            clearBlockedTimer();
            const db = request.result;
            if (settled) {
                // The open outlived its timeout. Nothing is tracking this
                // handle, and an onversionchange installed here would delete the
                // cache entry of whatever connection replaced us.
                db.close();
                return;
            }
            settled = true;
            // Close on versionchange so an external indexedDB.deleteDatabase()
            // (or a version upgrade in another tab) isn't blocked by this connection.
            db.onversionchange = () => {
                db.close();
                dbCache.delete(dbName);
                refCounts.delete(dbName);
            };
            resolve(db);
        };
        request.onupgradeneeded = (event) => {
            clearBlockedTimer();
            // Deliberately NOT gated on `settled`: a late upgrade commits before
            // `onsuccess` fires, so letting it finish leaves the database
            // correctly migrated and the next retry simply finds it done.
            // Aborting would only make that retry redo the work.
            const db = request.result;
            initDatabase(db, event.oldVersion, request.transaction);
        };
        request.onblocked = () => {
            console.warn("Database upgrade blocked - close other tabs/connections");
            // The only place a timer ever starts: the blast radius is every SDK
            // indexedDB repository, and an open that is merely slow must not be
            // failed.
            blockedTimer = setTimeout(() => {
                if (settled) return;
                settled = true;
                // cleared so a retry is possible at all — `openDatabase` would
                // otherwise serve this rejected promise from the cache forever
                dbCache.delete(dbName);
                refCounts.delete(dbName);
                reject(new DatabaseUpgradeBlockedError(dbName));
            }, BLOCKED_UPGRADE_TIMEOUT_MS);
        };
    });

    // Cache immediately before awaiting
    dbCache.set(dbName, { version: dbVersion, promise: dbPromise });
    refCounts.set(dbName, 1);

    return dbPromise;
}

/**
 * Decrements the reference count and closes the database when no references remain.
 *
 * @param dbName The name of the database to close.
 *
 * @returns True if the database was closed, false otherwise.
 */
export async function closeDatabase(dbName: string): Promise<boolean> {
    const cachedEntry = dbCache.get(dbName);
    if (!cachedEntry) return false;

    const count = (refCounts.get(dbName) ?? 1) - 1;
    if (count > 0) {
        refCounts.set(dbName, count);
        return false;
    }

    // Last reference — actually close
    refCounts.delete(dbName);
    dbCache.delete(dbName);

    try {
        const db = await cachedEntry.promise;
        db.close();
    } catch {
        // DB failed to open, nothing to close
    }
    return true;
}
