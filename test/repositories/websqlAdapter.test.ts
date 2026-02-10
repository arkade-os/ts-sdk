import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type MockDb = {
    getAllSync: ReturnType<typeof vi.fn>;
    runSync: ReturnType<typeof vi.fn>;
    withTransactionSync: ReturnType<typeof vi.fn>;
};

const openDatabaseSyncMock = vi.fn();

function createMockDb(): MockDb {
    return {
        getAllSync: vi.fn(),
        runSync: vi.fn(),
        withTransactionSync: vi.fn((cb: () => void) => cb()),
    };
}

// Hoisted mock for expo-sqlite used by the adapter under test
vi.mock("expo-sqlite", () => ({
    openDatabaseSync: openDatabaseSyncMock,
}));

openDatabaseSyncMock.mockImplementation(() => createMockDb());

async function loadAdapter() {
    return import("../../src/repositories/indexedDB/websqlAdapter");
}

async function createDb(name = "test-db") {
    const { openDatabase } = await loadAdapter();
    const webDb = openDatabase(name, "1", "display", 0);
    const sqliteDb = (webDb as any)._db as MockDb;
    return { webDb, sqliteDb };
}

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    openDatabaseSyncMock.mockClear();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("websqlAdapter", () => {
    it("reuses the same SQLite database instance per name", async () => {
        const { openDatabase } = await loadAdapter();

        const db1 = openDatabase("cache-db", "1", "", 0) as any;
        const db2 = openDatabase("cache-db", "1", "", 0) as any;
        const db3 = openDatabase("other-db", "1", "", 0) as any;

        expect(openDatabaseSyncMock).toHaveBeenCalledTimes(2);
        expect(db1._db).toBe(db2._db);
        expect(db1._db).not.toBe(db3._db);
    });

    it("executes read statements via getAllSync and returns WebSQL shaped results", async () => {
        const { webDb, sqliteDb } = await createDb("read-db");
        const rows = [{ id: 1, name: "Alice" }];
        sqliteDb.getAllSync.mockReturnValue(rows);

        const success = vi.fn();

        webDb.transaction((tx) => {
            tx.executeSql("SELECT * FROM foo", [123], success);
        });

        vi.runAllTimers();

        expect(sqliteDb.withTransactionSync).toHaveBeenCalledTimes(1);
        expect(sqliteDb.getAllSync).toHaveBeenCalledWith("SELECT * FROM foo", [
            123,
        ]);
        expect(success).toHaveBeenCalledTimes(1);
        const [, resultSet] = success.mock.calls[0];
        expect(resultSet.rows.length).toBe(1);
        expect(resultSet.rows.item(0)).toEqual(rows[0]);
        expect(resultSet.insertId).toBe(0);
        expect(resultSet.rowsAffected).toBe(0);
    });

    it("executes write statements via runSync and surfaces insert metadata", async () => {
        const { webDb, sqliteDb } = await createDb("write-db");
        sqliteDb.runSync.mockReturnValue({ lastInsertRowId: 5, changes: 2 });

        const success = vi.fn();

        webDb.transaction((tx) => {
            tx.executeSql("INSERT INTO foo VALUES (?)", ["bar"], success);
        });

        vi.runAllTimers();

        expect(sqliteDb.runSync).toHaveBeenCalledWith(
            "INSERT INTO foo VALUES (?)",
            ["bar"]
        );
        const [, resultSet] = success.mock.calls[0];
        expect(resultSet.insertId).toBe(5);
        expect(resultSet.rowsAffected).toBe(2);
        expect(resultSet.rows.length).toBe(0);
        expect(resultSet.rows.item(0)).toBeUndefined();
    });

    it("continues processing when a statement error handler returns false", async () => {
        const { webDb, sqliteDb } = await createDb("continue-db");
        sqliteDb.runSync.mockImplementationOnce(() => {
            throw new Error("boom");
        });
        sqliteDb.getAllSync.mockReturnValue([{ ok: true }]);

        const stmtError = vi.fn().mockReturnValue(false);
        const stmtSuccess = vi.fn();
        const txnSuccess = vi.fn();
        const txnError = vi.fn();

        webDb.transaction(
            (tx) => {
                tx.executeSql(
                    "INSERT INTO bad VALUES (?)",
                    [1],
                    undefined,
                    stmtError
                );
                tx.executeSql("SELECT * FROM ok", [], stmtSuccess);
            },
            txnError,
            txnSuccess
        );

        vi.runAllTimers();

        expect(stmtError).toHaveBeenCalledTimes(1);
        expect(stmtSuccess).toHaveBeenCalledTimes(1);
        expect(txnSuccess).toHaveBeenCalledTimes(1);
        expect(txnError).not.toHaveBeenCalled();
        expect(sqliteDb.getAllSync).toHaveBeenCalledTimes(1);
    });

    it("aborts the transaction and forwards errors when not handled", async () => {
        const { webDb, sqliteDb } = await createDb("abort-db");
        sqliteDb.runSync.mockImplementation(() => {
            throw new Error("fail");
        });

        const txnError = vi.fn();
        const txnSuccess = vi.fn();
        const stmtSuccess = vi.fn();

        webDb.transaction(
            (tx) => {
                tx.executeSql("INSERT INTO fail VALUES (1)", [], stmtSuccess);
                tx.executeSql("SELECT * FROM skipped", [], stmtSuccess);
            },
            txnError,
            txnSuccess
        );

        vi.runAllTimers();

        expect(txnError).toHaveBeenCalledTimes(1);
        expect(txnError.mock.calls[0][0].message).toBe("fail");
        expect(txnSuccess).not.toHaveBeenCalled();
        expect(stmtSuccess).not.toHaveBeenCalled();
        expect(sqliteDb.getAllSync).not.toHaveBeenCalled();
    });

    it("allows success callbacks to enqueue additional statements", async () => {
        const { webDb, sqliteDb } = await createDb("chained-db");
        sqliteDb.getAllSync
            .mockReturnValueOnce([{ id: 1 }])
            .mockReturnValueOnce([{ id: 2 }]);

        const firstSuccess = vi.fn((tx: any) => {
            tx.executeSql("PRAGMA table_info(foo)", [], secondSuccess);
        });
        const secondSuccess = vi.fn();

        webDb.transaction((tx) => {
            tx.executeSql("SELECT * FROM foo", [], firstSuccess);
        });

        vi.runAllTimers();

        expect(firstSuccess).toHaveBeenCalledTimes(1);
        expect(secondSuccess).toHaveBeenCalledTimes(1);
        expect(sqliteDb.getAllSync).toHaveBeenCalledTimes(2);
        expect(sqliteDb.runSync).not.toHaveBeenCalled();
    });

    it("readTransaction delegates to transaction", async () => {
        const { webDb, sqliteDb } = await createDb();
        sqliteDb.getAllSync.mockReturnValue([]);
        const cb = vi.fn((tx: any) => tx.executeSql("SELECT 1", []));
        webDb.readTransaction(cb);
        vi.runAllTimers();
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it("invokes the creation callback with the database", async () => {
        const { openDatabase } = await loadAdapter();
        const cb = vi.fn();
        const db = openDatabase("cb-db", "1", "", 0, cb);
        expect(cb).toHaveBeenCalledWith(db);
    });
});
