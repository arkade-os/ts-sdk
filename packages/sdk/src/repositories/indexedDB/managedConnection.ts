import { closeDatabase, openDatabase } from "./manager";

/** A disposed {@link ManagedConnection} was read from. Reopening instead would
 * take a refcount nothing will ever release, so this is loud rather than
 * silently leaky: the fix belongs at the caller, which is using a repository it
 * already tore down. */
export class ConnectionDisposedError extends Error {
    override readonly name = "ConnectionDisposedError";
    constructor(readonly dbName: string) {
        super(`connection to database "${dbName}" was disposed`);
    }
}

/** Lazily-opened, self-healing handle on one IndexedDB database. */
export interface ManagedConnection extends AsyncDisposable {
    /**
     * The open connection, opening it on first call.
     *
     * Call once per operation and use the handle for the transaction you start right away —
     * never store it or carry it across an `await`. It can be closed underneath you at any time
     * (`versionchange` from another tab, eviction, "clear site data"), after which every
     * transaction on it throws `InvalidStateError`; a later `get()` transparently reopens.
     *
     * After `[Symbol.asyncDispose]` it rejects with {@link ConnectionDisposedError}, permanently:
     * reopening would take a refcount nothing releases, so construct a new repository instead.
     * Dispose neither awaits nor cancels in-flight work, so `await` outstanding repository calls
     * before disposing. Callers must not close the database themselves.
     */
    get(): Promise<IDBDatabase>;
}

/**
 * Forget-and-reopen around {@link openDatabase}, shared by every IndexedDB repository: a cached
 * `IDBDatabase` throws `InvalidStateError` forever once the manager closes it on `versionchange`.
 * Lazy, so the "IndexedDB is not available" throw stays out of repository constructors.
 */
export function createManagedConnection(
    dbName: string,
    version: number,
    initDatabase: (db: IDBDatabase, oldVersion: number, transaction: IDBTransaction | null) => void,
): ManagedConnection {
    // the opening promise, not the database: openDatabase bumps a refcount on every
    // call (cache hits too) while dispose closes once, so two concurrent first calls
    // would leak the connection for the process lifetime.
    let current: Promise<IDBDatabase> | null = null;
    let disposed = false;

    return {
        get(): Promise<IDBDatabase> {
            if (disposed) return Promise.reject(new ConnectionDisposedError(dbName));
            if (current) return current;
            const opening = openDatabase(dbName, version, initDatabase)
                .then((db) => {
                    // identity check: a reopen may already have replaced this
                    // promise, and nulling that one would drop a live connection
                    const forget = () => {
                        if (current === opening) current = null;
                    };
                    // addEventListener, not `db.onversionchange =`, which is the
                    // manager's. `close` fires only on ABNORMAL termination, never
                    // on an explicit close(), so the two never double-fire.
                    db.addEventListener("versionchange", forget);
                    db.addEventListener("close", forget);
                    return db;
                })
                .catch((err) => {
                    // forgotten so a retry is possible, else a VersionError sticks
                    if (current === opening) current = null;
                    throw err;
                });
            current = opening;
            return opening;
        },

        async [Symbol.asyncDispose](): Promise<void> {
            if (disposed) return;
            disposed = true;
            // only while a promise is held: every rejection path already nulled
            // it, and closing then would decrement a successor's refcount
            if (!current) return;
            current = null;
            await closeDatabase(dbName);
        },
    };
}
