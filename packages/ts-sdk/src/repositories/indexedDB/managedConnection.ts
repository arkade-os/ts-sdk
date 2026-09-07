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
     * Call this once per operation and use the handle for the transaction you
     * start right away — never store it on the repository, and never carry it
     * across an `await`. The connection can be closed underneath you at any
     * time (a `versionchange` from another tab, eviction, "clear site data"),
     * after which every transaction on that handle throws `InvalidStateError`;
     * a later `get()` transparently reopens, but only for callers that ask
     * again. Holding the resolved database is exactly the defect this type
     * exists to remove.
     *
     * ## The dispose boundary
     *
     * `get()` is valid only before `[Symbol.asyncDispose]`. Afterwards it
     * rejects with {@link ConnectionDisposedError}, permanently: dispose has
     * released this connection's single reference, and reopening would take a
     * refcount nothing is left to release. Disposal is final by design — there
     * is no revive; construct a new repository, which constructs a new
     * connection, instead.
     *
     * Dispose neither awaits nor cancels work already in flight. A transaction
     * started just before it can abort when the underlying handle closes, and
     * an in-flight `get()` may resolve to a database that is closing. So
     * sequence disposal after the operations you care about have settled —
     * `await` the repository's outstanding calls first — rather than racing it
     * against them.
     *
     * Callers must not close the database themselves; the reference this
     * connection holds is released by its own dispose, once.
     */
    get(): Promise<IDBDatabase>;
}

/**
 * Forget-and-reopen around {@link openDatabase}, shared by every IndexedDB
 * repository. Caching the resolved `IDBDatabase` is the defect this exists to
 * remove: once the manager closes on `versionchange`, every later transaction on
 * that handle throws `InvalidStateError` with no path back.
 *
 * Opens nothing until the first {@link ManagedConnection.get} — repositories
 * construct their storage in their own constructors, and an eager open would
 * move the "IndexedDB is not available in this environment" throw to
 * construction time.
 */
export function createManagedConnection(
    dbName: string,
    version: number,
    initDatabase: (db: IDBDatabase, oldVersion: number, transaction: IDBTransaction | null) => void,
): ManagedConnection {
    // the opening promise, not the resolved database: openDatabase bumps a
    // refcount on every call including cache hits, while dispose closes once, so
    // two concurrent first calls would strand the refcount above zero and leak
    // the connection for the process lifetime.
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
                    // addEventListener, not `db.onversionchange =`: that handler
                    // is the manager's, and its close is what we want to keep.
                    // `close` fires only on ABNORMAL termination per spec — never
                    // on an explicit close() — so the two never double-fire.
                    db.addEventListener("versionchange", forget);
                    db.addEventListener("close", forget);
                    return db;
                })
                .catch((err) => {
                    // forgotten so a retry is possible at all — otherwise a
                    // VersionError from a newer tab sticks instead of failing
                    // repeatably
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
