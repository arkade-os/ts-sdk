import { initDatabase } from "../repositories/indexedDB/schema";

export function getGlobalObject(): {
    globalObject: typeof globalThis;
} {
    if (typeof globalThis !== "undefined") {
        if (typeof globalThis.self === "object" && globalThis.self !== null) {
            return { globalObject: globalThis.self };
        }
        if (
            typeof globalThis.window === "object" &&
            globalThis.window !== null
        ) {
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
 * @param initDatabase A function that migrates the database schema, called on `onupgradeneeded` only.
 *
 * @returns A promise that resolves to the database instance.
 */
export async function openDatabase(
    dbName: string,
    dbVersion: number,
    initDatabase: (db: IDBDatabase) => void
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
                `Database "${dbName}" already opened with version ${cached.version}; requested ${dbVersion}`
            );
        }
        refCounts.set(dbName, (refCounts.get(dbName) ?? 0) + 1);
        return cached.promise;
    }

    const dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = globalObject.indexedDB.open(dbName, dbVersion);

        request.onerror = () => {
            dbCache.delete(dbName); // Clean up on failure
            refCounts.delete(dbName);
            reject(request.error);
        };
        request.onsuccess = () => {
            resolve(request.result);
        };
        request.onupgradeneeded = () => {
            const db = request.result;
            initDatabase(db);
        };
        request.onblocked = () => {
            console.warn(
                "Database upgrade blocked - close other tabs/connections"
            );
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
