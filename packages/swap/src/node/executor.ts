/**
 * A file-backed `SQLExecutor` over Node's built-in SQLite, and the repository
 * that owns one.
 *
 * §3's Node default. The only in-tree executors were a test helper hard-coded
 * to `":memory:"` and an example built on a `better-sqlite3` devDependency that
 * no package ships — so a Node consumer following the documented default had
 * nothing to import. This is that import.
 *
 * It lives behind the `./node` subpath rather than inside the main entry so the
 * browser bundle never sees `node:sqlite`. The alternative — a guarded dynamic
 * `import("node:sqlite")` in the main entry — keeps one import site and hands
 * every bundler a conditional it has to be told to drop.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SQLExecutor } from "@arkade-os/sdk/repositories/sqlite";
import { SQLiteAssetSwapRepository } from "../repositories/sqlite";
import type { AssetSwapRepository } from "../repository";
import { swapDatabasePath } from "./paths";

/**
 * An executor that owns its connection.
 *
 * `SQLExecutor` declares no lifecycle — the interface is three query methods,
 * because every other implementation wraps a connection the consumer already
 * opened. This one opens the file itself, so it is the one that has something
 * to close.
 */
export interface NodeSqlExecutor extends SQLExecutor {
    /** Close the underlying database handle. Idempotent. */
    close(): Promise<void>;
}

/**
 * `node:sqlite` rejects a bound `undefined`; `null` is what it means.
 *
 * The cast is the seam between two vocabularies: `SQLExecutor` types its
 * parameters as `unknown[]`, because it is implemented over drivers that each
 * accept their own scalar set, while `node:sqlite` names its set exactly. Every
 * value this package binds is a string, a number or `null` — the repositories
 * store records as JSON text and map out only `id`-like strings and integer
 * timestamps — so a value outside that set is a caller's bug, and the driver
 * throws on it either way.
 */
const bindable = (params?: unknown[]): SQLInputValue[] =>
    (params ?? []).map((p) => (p === undefined ? null : (p as SQLInputValue)));

/**
 * Open (creating if absent) a SQLite database at `path`.
 *
 * **One instance per file, held for the process's life.** `runInTransaction`
 * keys its write chain on the executor *object* through a `WeakMap`, so a
 * second executor over the same file forks the chain and two "transactions" can
 * interleave on one connection. Every repository on a database must be handed
 * the same instance — which is what {@link nodeSwapRepository} does for the
 * common case.
 *
 * The parent directory is created on open: the config dir exists on any real
 * machine but `arkade/swaps` under it does not, and failing on a first run for
 * a directory the caller never chose would be a poor default.
 */
export const createNodeSqlExecutor = (path: string): NodeSqlExecutor => {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    let open = true;
    return {
        async run(sql: string, params?: unknown[]): Promise<void> {
            db.prepare(sql).run(...bindable(params));
        },
        async get<T = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
        ): Promise<T | undefined> {
            return (db.prepare(sql).get(...bindable(params)) as T | undefined) ?? undefined;
        },
        async all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
            return db.prepare(sql).all(...bindable(params)) as T[];
        },
        async close(): Promise<void> {
            // Idempotent: `await using` disposal and an explicit `close()` in a
            // shutdown handler both happen in practice, and the second
            // `db.close()` would throw.
            if (!open) return;
            open = false;
            db.close();
        },
    };
};

export interface NodeSwapRepositoryOptions {
    /**
     * Which network's database. Used to build the default path — pass the same
     * name the wallet reports.
     */
    readonly network: string;
    /** An explicit path, overriding the platform default. */
    readonly path?: string;
    /** Table-name prefix, passed through to the SQLite backend. */
    readonly prefix?: string;
}

/**
 * The Node storage default, connection included.
 *
 * This is where D1/D2's ownership rule lands: the returned repository's
 * `[Symbol.asyncDispose]` closes the connection **it** opened, and an injected
 * repository is disposed by whoever built it — which is already true of every
 * other backend, whose disposal is a no-op precisely because the consumer owns
 * the handle.
 *
 * Hanging ownership on the repository rather than on a client lifecycle method
 * is deliberate: the v2 client has no `stop()` or `dispose()` yet — the
 * lifecycle is the next milestone's — and a connection that could only be
 * closed through a method that does not exist would leak until the process
 * ended.
 *
 * ```ts
 * await using repository = nodeSwapRepository({ network: "mainnet" });
 * const client = createSwapClient({ wallet, repository });
 * ```
 */
export const nodeSwapRepository = (options: NodeSwapRepositoryOptions): AssetSwapRepository => {
    const executor = createNodeSqlExecutor(options.path ?? swapDatabasePath(options.network));
    return new NodeSwapRepository(
        executor,
        options.prefix === undefined ? undefined : { prefix: options.prefix },
    );
};

/**
 * The SQLite backend, plus the one thing it cannot do: close a connection it
 * did not open.
 *
 * A subclass overriding exactly one method, rather than a delegating wrapper:
 * the base's `[Symbol.asyncDispose]` is a documented no-op *because* the
 * consumer owns the handle, and here the consumer is this class. Every other
 * method must keep working unchanged, which a hand-written delegate would have
 * to restate one by one and would silently miss on the next interface bump.
 */
class NodeSwapRepository extends SQLiteAssetSwapRepository {
    constructor(
        private readonly executor: NodeSqlExecutor,
        options?: { prefix?: string },
    ) {
        super(executor, options);
    }

    override async [Symbol.asyncDispose](): Promise<void> {
        await this.executor.close();
    }
}
