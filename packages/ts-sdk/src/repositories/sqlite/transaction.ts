import { SQLExecutor } from "./types";

// One write chain per connection. SQLite (a single connection) cannot nest
// BEGIN IMMEDIATE, so every transaction on a given executor must run one at a
// time — across ALL repositories that share it, not just one instance. Keyed
// by the executor object so callers keep passing a raw SQLExecutor with no
// wiring change; separate executors (separate connections) get separate chains.
const writeChains = new WeakMap<SQLExecutor, Promise<void>>();

/**
 * Run `fn` inside a serialized `BEGIN IMMEDIATE` / `COMMIT` on `db`.
 *
 * `fn` must issue only raw `db.run`/`db.all` calls: calling `runInTransaction`
 * again on the same `db` from within `fn` would wait on the chain it is part of
 * and deadlock.
 */
export function runInTransaction(db: SQLExecutor, fn: () => Promise<void>): Promise<void> {
    // Chain onto the previous transaction; no await between get and set, so the
    // enqueue is atomic.
    const prev = writeChains.get(db) ?? Promise.resolve();
    const run = prev.then(async () => {
        await db.run("BEGIN IMMEDIATE");
        try {
            await fn();
            await db.run("COMMIT");
        } catch (e) {
            try {
                await db.run("ROLLBACK");
            } catch {
                /* already rolled back */
            }
            throw e;
        }
    });
    // Keep the chain alive regardless of this run's outcome so a failed
    // transaction doesn't wedge every subsequent writer.
    writeChains.set(
        db,
        run.catch(() => {}),
    );
    return run;
}
