/**
 * A file-backed `SQLExecutor` over Node's built-in SQLite, and the repository that owns one.
 * Behind the `./node` subpath so browser bundles never see `node:sqlite`; a guarded dynamic
 * import in the main entry would force every bundler to be told to drop it.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SQLExecutor } from "@arkade-os/sdk/repositories/sqlite";
import { SQLiteAssetSwapRepository } from "../repositories/sqlite";
import type { AssetSwapRepository } from "../repository";
import { swapDatabasePath } from "./paths";

/**
 * An executor that owns its connection. `SQLExecutor` declares no lifecycle because other
 * implementations wrap a consumer-opened connection; this one opens the file itself.
 */
export interface NodeSqlExecutor extends SQLExecutor {
    /** Close the underlying database handle. Idempotent. */
    close(): Promise<void>;
}

/**
 * `node:sqlite` rejects a bound `undefined`; `null` is what it means. The cast is safe because
 * this package binds only strings, numbers and `null`; anything else throws in the driver anyway.
 */
const bindable = (params?: unknown[]): SQLInputValue[] =>
    (params ?? []).map((p) => (p === undefined ? null : (p as SQLInputValue)));

/**
 * Open (creating the file and its parent directory if absent) a SQLite database at `path`.
 *
 * **One instance per file, held for the process's life.** `runInTransaction` keys its write chain
 * on the executor *object* via a `WeakMap`, so a second executor over the same file forks the
 * chain and two "transactions" can interleave. {@link nodeSwapRepository} handles this for the
 * common case.
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
            // `await using` plus an explicit shutdown `close()` both happen; a second
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
 * The Node storage default, connection included. Its `[Symbol.asyncDispose]` closes the
 * connection **it** opened; an injected repository is disposed by whoever built it. Ownership
 * sits on the repository because the v2 client has no `dispose()` yet.
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
 * The SQLite backend, plus closing the connection it opened. A subclass rather than a delegating
 * wrapper so every other method keeps working without being restated on each interface bump.
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
