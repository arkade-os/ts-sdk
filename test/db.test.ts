import { describe, it, expect, vi } from "vitest";
import { openDatabase, closeDatabase } from "../src/db/manager";

let dbCounter = 0;
function getUniqueDbName(prefix: string): string {
    return `${prefix}-test-${Date.now()}-${++dbCounter}`;
}

describe("db manager", () => {
    it("opens and reuses the same version, tracking references", async () => {
        const dbName = getUniqueDbName("db-manager");
        const initDb = vi.fn();

        const db1 = await openDatabase(dbName, 1, initDb);
        const db2 = await openDatabase(dbName, 1, initDb);

        expect(db2).toBe(db1);
        expect(initDb).toHaveBeenCalled();

        const closedOnce = await closeDatabase(dbName);
        expect(closedOnce).toBe(false);

        const closedTwice = await closeDatabase(dbName);
        expect(closedTwice).toBe(true);
    });

    it("rejects opening a different version for the same DB name", async () => {
        const dbName = getUniqueDbName("db-manager-version");
        const initDb = vi.fn();

        await openDatabase(dbName, 1, initDb);

        expect(openDatabase(dbName, 2, initDb)).rejects.toThrow(
            /already opened with version 1/
        );

        const closed = await closeDatabase(dbName);
        expect(closed).toBe(true);
    });
});
