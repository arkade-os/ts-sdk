/**
 * WebSQL adapter over expo-sqlite.
 *
 * Bridges the WebSQL API surface that indexeddbshim expects to the
 * synchronous expo-sqlite driver.  Only the subset actually called by
 * the shim is implemented:
 *
 *   openDatabase(name, version, displayName, estimatedSize) → WebSQLDatabase
 *   db.transaction(cb, errCb?, successCb?)
 *   tx.executeSql(sql, args?, successCb?, errorCb?)
 *   resultSet = { insertId, rowsAffected, rows: { length, item(i) } }
 */

import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";

// ── Types ────────────────────────────────────────────────────────────

export interface SQLResultSetRowList {
    length: number;
    item(index: number): any;
}

export interface SQLResultSet {
    insertId: number;
    rowsAffected: number;
    rows: SQLResultSetRowList;
}

export interface SQLError {
    code: number;
    message: string;
}

type ExecuteSqlSuccessCb = (
    tx: WebSQLTransaction,
    resultSet: SQLResultSet
) => void;
type ExecuteSqlErrorCb = (
    tx: WebSQLTransaction,
    error: SQLError
) => boolean | void;

interface QueuedStatement {
    sql: string;
    args: any[];
    successCb?: ExecuteSqlSuccessCb;
    errorCb?: ExecuteSqlErrorCb;
}

// ── Database cache ───────────────────────────────────────────────────

const dbCache = new Map<string, SQLiteDatabase>();

function getSqliteDb(name: string): { db: SQLiteDatabase; created: boolean } {
    let db = dbCache.get(name);
    if (db) return { db, created: false };
    db = openDatabaseSync(name);
    dbCache.set(name, db);
    return { db, created: true };
}

// ── WebSQLTransaction ────────────────────────────────────────────────

export class WebSQLTransaction {
    /** @internal */
    _queue: QueuedStatement[] = [];

    executeSql(
        sql: string,
        args?: any[],
        successCb?: ExecuteSqlSuccessCb,
        errorCb?: ExecuteSqlErrorCb
    ): void {
        this._queue.push({ sql, args: args ?? [], successCb, errorCb });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

function isRead(sql: string): boolean {
    const trimmed = sql.trimStart().toUpperCase();
    return trimmed.startsWith("SELECT") || trimmed.startsWith("PRAGMA");
}

function buildResultSet(
    db: SQLiteDatabase,
    sql: string,
    args: any[]
): SQLResultSet {
    if (isRead(sql)) {
        const rows = db.getAllSync(sql, args);
        return {
            insertId: 0,
            rowsAffected: 0,
            rows: {
                length: rows.length,
                item(i: number) {
                    return rows[i];
                },
            },
        };
    }

    const result = db.runSync(sql, args);
    return {
        insertId: result.lastInsertRowId,
        rowsAffected: result.changes,
        rows: {
            length: 0,
            item(_i: number) {
                return undefined;
            },
        },
    };
}

function drainQueue(db: SQLiteDatabase, tx: WebSQLTransaction): void {
    // Process until the queue is empty.  Success callbacks may enqueue
    // more statements, so we loop rather than iterate a snapshot.
    while (tx._queue.length > 0) {
        const stmt = tx._queue.shift()!;
        try {
            const rs = buildResultSet(db, stmt.sql, stmt.args);
            if (stmt.successCb) {
                stmt.successCb(tx, rs);
            }
        } catch (err: any) {
            const sqlError: SQLError = {
                code: 0,
                message: err?.message ?? String(err),
            };
            if (stmt.errorCb) {
                const shouldContinue = stmt.errorCb(tx, sqlError);
                if (shouldContinue === true) {
                    // Error handler returned true → swallow error and continue
                    continue;
                }
            }
            // Abort the transaction
            throw err;
        }
    }
}

// ── WebSQLDatabase ───────────────────────────────────────────────────

export class WebSQLDatabase {
    /** @internal */
    _db: SQLiteDatabase;
    version: string;

    constructor(db: SQLiteDatabase, version: string) {
        this._db = db;
        this.version = version;
    }

    transaction(
        callback: (tx: WebSQLTransaction) => void,
        errorCb?: (error: SQLError) => void,
        successCb?: () => void
    ): void {
        // WebSQL is async/callback-based.  Schedule via macrotask so the
        // caller's subsequent code runs first (matches browser behavior).
        setTimeout(() => {
            const tx = new WebSQLTransaction();
            try {
                // Let the caller enqueue statements
                callback(tx);

                // Execute everything inside a real SQLite transaction
                this._db.withTransactionSync(() => {
                    drainQueue(this._db, tx);
                });

                if (successCb) successCb();
            } catch (err: any) {
                const sqlError: SQLError = {
                    code: 0,
                    message: err?.message ?? String(err),
                };
                if (errorCb) {
                    errorCb(sqlError);
                }
            }
        }, 0);
    }

    readTransaction(
        callback: (tx: WebSQLTransaction) => void,
        errorCb?: (error: SQLError) => void,
        successCb?: () => void
    ): void {
        // Reads go through the same path — SQLite handles concurrency.
        this.transaction(callback, errorCb, successCb);
    }
}

// ── openDatabase (WebSQL entry point) ────────────────────────────────

export function openDatabase(
    name: string,
    version: string,
    _displayName: string,
    _estimatedSize: number,
    _creationCallback?: (db: WebSQLDatabase) => void
): WebSQLDatabase {
    const { db: sqliteDb, created } = getSqliteDb(name);
    const wsdb = new WebSQLDatabase(sqliteDb, version);
    if (created && _creationCallback) {
        _creationCallback(wsdb);
    }
    return wsdb;
}
