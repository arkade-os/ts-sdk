/**
 * A blocked upgrade must fail rather than hang.
 *
 * `onblocked` fires when another connection holds the database at a lower
 * version; the open request then waits for that connection to close, however
 * long that takes, and settles neither way. A caller cannot retry what never
 * settles, so the manager gives it a deadline — and, because rejecting does not
 * cancel the request, must also make sure the open that completes afterwards
 * cannot touch its successor's bookkeeping.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
    openDatabase,
    closeDatabase,
    BLOCKED_UPGRADE_TIMEOUT_MS,
} from "../src/repositories/indexedDB/manager";

/** A connection at v1 with NO versionchange handler, so it genuinely blocks. */
const blockingConnection = (dbName: string): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
        const open = indexedDB.open(dbName, 1);
        open.onupgradeneeded = () => open.result.createObjectStore("rows");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
    });

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * `onblocked` is dispatched on the task queue, which the fake clock only runs
 * once it is advanced — so the wait has to be split. Advancing in one step
 * schedules the timeout at the far end of the window it was supposed to fire in,
 * and the rejection never happens.
 */
const advancePastTimeout = async () => {
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(BLOCKED_UPGRADE_TIMEOUT_MS + 10);
};

afterEach(() => {
    vi.useRealTimers();
});

describe("a blocked database upgrade", () => {
    it("rejects with the database's name instead of hanging", async () => {
        const dbName = `blocked-${Math.random()}`;
        const blocker = await blockingConnection(dbName);
        vi.useFakeTimers();
        try {
            const opening = openDatabase(dbName, 2, (db) => {
                db.createObjectStore("added");
            });
            const settled = expect(opening).rejects.toMatchObject({
                name: "DatabaseUpgradeBlockedError",
                message: expect.stringContaining(dbName),
            });
            await advancePastTimeout();
            await settled;
        } finally {
            blocker.close();
        }
    });

    it("closes the connection the open produced after the caller was told it failed", async () => {
        // The assertion the `settled` guard exists for, and the only one found
        // that fails without it. Every indirect probe is blind: the ungated
        // `onsuccess` installs `db.onversionchange`, so any upgrade or delete
        // used to OBSERVE the leaked connection is itself what closes it. Hence
        // the spy on `indexedDB.open` — the manager holds the only reference —
        // and hence probing the handle before touching the database any other
        // way.
        const dbName = `ghost-${Math.random()}`;
        const blocker = await blockingConnection(dbName);
        // Captured on the success event rather than read off the request later:
        // `request.result` throws `InvalidStateError` while the request is still
        // pending, which is the very symptom being asserted on. Registered before
        // the manager's own handler, so this sees the handle it is about to
        // close.
        const opened: IDBDatabase[] = [];
        const realOpen = indexedDB.open.bind(indexedDB);
        const spy = vi
            .spyOn(indexedDB, "open")
            .mockImplementation((name: string, version?: number) => {
                const request = realOpen(name, version);
                request.addEventListener("success", () => opened.push(request.result));
                return request;
            });
        vi.useFakeTimers();
        try {
            const opening = openDatabase(dbName, 2, (db) => {
                db.createObjectStore("added");
            });
            const settled = expect(opening).rejects.toThrow(/upgrade blocked/);
            await advancePastTimeout();
            await settled;

            // Now let the open complete behind the failure we already reported —
            // still on the fake clock, because fake-indexeddb dispatches through
            // whatever `setImmediate` is installed, and switching back to real
            // timers here would discard the queue the pending open lives on.
            blocker.close();
            for (let turn = 0; turn < 20 && opened.length === 0; turn++) {
                await vi.advanceTimersByTimeAsync(1);
            }
            expect(opened).toHaveLength(1);

            const [ghost] = opened;
            // A closed connection throws InvalidStateError on `transaction`; an
            // open one does not. Nothing else here may touch the database first,
            // or the assertion contaminates its own subject: any upgrade or
            // delete would fire `versionchange` at a leaked connection whose
            // handler closes it.
            expect(() => ghost.transaction(["added"], "readonly")).toThrow();

            // and the retry the timeout made possible works, rather than being
            // served the rejected promise from the cache. Back on real timers
            // first: awaiting an open while nothing advances the fake clock is a
            // deadlock, and the queue this test needed is drained by now.
            vi.useRealTimers();
            const db = await openDatabase(dbName, 2, (upgrading) => {
                upgrading.createObjectStore("added");
            });
            expect(db.objectStoreNames.contains("added")).toBe(true);
            await closeDatabase(dbName);
        } finally {
            spy.mockRestore();
            blocker.close();
        }
    });
});
