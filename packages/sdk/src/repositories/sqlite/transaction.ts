import { SQLExecutor } from "./types";

type ExecutorQueue = {
    raw: SQLExecutor;
    facade: SQLExecutor;
    tail: Promise<unknown>;
    inTransaction: boolean;
};
const executorQueues = new WeakMap<SQLExecutor, ExecutorQueue>();

const STALL_WARN_MS = 10_000;

function enqueue<T>(queue: ExecutorQueue, operation: () => Promise<T>): Promise<T> {
    // A queued call made from inside a transaction callback waits on that callback forever.
    // Telling it apart from a concurrent caller needs async context that Hermes lacks, so warn
    // instead of failing, with the stack captured at the call site.
    let stall: ReturnType<typeof setTimeout> | undefined;
    if (queue.inTransaction) {
        const site = new Error(
            `SQLite operation waited ${STALL_WARN_MS / 1000}s behind a transaction. A repository, ` +
                "getSerializedExecutor or runInTransaction call inside a runInTransaction " +
                "callback deadlocks; use the callback's tx.",
        );
        stall = setTimeout(() => console.warn(site), STALL_WARN_MS);
    }
    const run = queue.tail.then(() => {
        clearTimeout(stall);
        return operation();
    });
    queue.tail = run.catch(() => undefined);
    return run;
}

function queueFor(db: SQLExecutor): ExecutorQueue {
    const existing = executorQueues.get(db);
    if (existing) return existing;
    // These closures run only after queue has been initialized.
    const facade: SQLExecutor = {
        run: (sql, params) => enqueue(queue, () => db.run(sql, params)),
        get: <T>(sql: string, params?: unknown[]) => enqueue(queue, () => db.get<T>(sql, params)),
        all: <T>(sql: string, params?: unknown[]) => enqueue(queue, () => db.all<T>(sql, params)),
    };
    const queue: ExecutorQueue = {
        raw: db,
        facade,
        tail: Promise.resolve(),
        inTransaction: false,
    };
    executorQueues.set(db, queue);
    executorQueues.set(facade, queue);
    return queue;
}

/** SDK reads and writes share the transaction queue; direct raw-driver calls do not. */
export function getSerializedExecutor(db: SQLExecutor): SQLExecutor {
    return queueFor(db).facade;
}

/**
 * Run `fn` inside `BEGIN IMMEDIATE` / `COMMIT`, excluding queued SDK reads and writes.
 * Use only the supplied raw executor inside `fn`; repository calls or nested transactions deadlock.
 * Existing zero-argument callbacks closing over the original raw executor remain supported.
 */
export function runInTransaction(
    db: SQLExecutor,
    fn: (tx: SQLExecutor) => Promise<void>,
): Promise<void> {
    const queue = queueFor(db);
    return enqueue(queue, async () => {
        const tx = queue.raw;
        queue.inTransaction = true;
        try {
            await tx.run("BEGIN IMMEDIATE");
            try {
                await fn(tx);
                await tx.run("COMMIT");
            } catch (e) {
                try {
                    await tx.run("ROLLBACK");
                } catch {
                    /* already rolled back */
                }
                throw e;
            }
        } finally {
            queue.inTransaction = false;
        }
    });
}
