import { W as WalletRepository, E as ExtendedVirtualCoin, s as VtxoRepositoryKey, d as ExtendedCoin, A as ArkTransaction, t as WalletState, C as ContractRepository, u as ContractFilter, r as Contract } from '../../ark-BCdDnaIQ.cjs';
import '@scure/btc-signer/transaction.js';
import '@scure/btc-signer/utils.js';
import '@scure/btc-signer/psbt.js';
import '@scure/btc-signer';

/**
 * Minimal SQL execution interface that consumers implement
 * to connect their SQLite (or any SQL) database to the SDK.
 *
 * Example for expo-sqlite:
 * ```
 * const executor: SQLExecutor = {
 *   run: (sql, params) => db.runAsync(sql, params ?? []),
 *   get: (sql, params) => db.getFirstAsync(sql, params ?? []),
 *   all: (sql, params) => db.getAllAsync(sql, params ?? []),
 * };
 * ```
 */
interface SQLExecutor {
    run(sql: string, params?: unknown[]): Promise<void>;
    get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
    all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

interface SQLiteWalletRepositoryOptions {
    /** Table name prefix (default: "ark_") */
    prefix?: string;
}
/**
 * SQLite-based implementation of WalletRepository.
 *
 * Uses the SQLExecutor interface so consumers can plug in any SQLite driver
 * (expo-sqlite, better-sqlite3, etc.).
 *
 * Tables are created lazily on first operation via `ensureInit()`.
 * The consumer owns the SQLExecutor lifecycle — `[Symbol.asyncDispose]` is a no-op.
 */
declare class SQLiteWalletRepository implements WalletRepository {
    private readonly db;
    readonly version: 1;
    private initPromise;
    private readonly prefix;
    private readonly tables;
    constructor(db: SQLExecutor, options?: SQLiteWalletRepositoryOptions);
    private ensureInit;
    private init;
    /**
     * Bring the `vtxos` table to the current schema (v1 = `script` NOT NULL).
     *
     * Three cases:
     *   - Fresh install: create the v1 schema directly.
     *   - Legacy install without a `script` column: add it, backfill from
     *     `address`, then rebuild the table with NOT NULL (SQLite cannot add
     *     the NOT NULL constraint in place).
     *   - Legacy install with a nullable `script` column: backfill the NULLs
     *     and rebuild.
     *
     * The backfill derives `script` from the Ark address, matching what the
     * indexer would have returned — new rows from the indexer always carry a
     * populated `script`, so the migration is idempotent.
     *
     * The rebuild path is wrapped in a transaction: without it, a crash
     * between the `DROP TABLE vtxos` and the `RENAME tmp → vtxos` commits
     * would leave the next startup seeing no `vtxos` table and create a
     * fresh empty one, silently orphaning every row in the temp table.
     */
    private migrateVtxosTable;
    private vtxosCreateSql;
    [Symbol.asyncDispose](): Promise<void>;
    clear(): Promise<void>;
    getVtxos(address: string): Promise<ExtendedVirtualCoin[]>;
    saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    deleteVtxos(address: string): Promise<void>;
    getVtxosForScript(script: string): Promise<ExtendedVirtualCoin[]>;
    saveVtxosForScript(key: VtxoRepositoryKey, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    deleteVtxosForScript(script: string): Promise<void>;
    getUtxos(address: string): Promise<ExtendedCoin[]>;
    saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void>;
    deleteUtxos(address: string): Promise<void>;
    getTransactionHistory(address: string): Promise<ArkTransaction[]>;
    saveTransactions(address: string, txs: ArkTransaction[]): Promise<void>;
    deleteTransactions(address: string): Promise<void>;
    getWalletState(): Promise<WalletState | null>;
    saveWalletState(state: WalletState): Promise<void>;
}

interface SQLiteContractRepositoryOptions {
    /** Table name prefix (default: "ark_") */
    prefix?: string;
}
/**
 * SQLite-based implementation of ContractRepository.
 *
 * Uses the SQLExecutor interface so consumers can plug in any SQLite driver
 * (expo-sqlite, better-sqlite3, etc.).
 *
 * Tables are created lazily on first operation via `ensureInit()`.
 * The consumer owns the SQLExecutor lifecycle — `[Symbol.asyncDispose]` is a no-op.
 */
declare class SQLiteContractRepository implements ContractRepository {
    private readonly db;
    readonly version: 1;
    private initPromise;
    private readonly prefix;
    private readonly table;
    constructor(db: SQLExecutor, options?: SQLiteContractRepositoryOptions);
    private ensureInit;
    private init;
    [Symbol.asyncDispose](): Promise<void>;
    clear(): Promise<void>;
    getContracts(filter?: ContractFilter): Promise<Contract[]>;
    saveContract(contract: Contract): Promise<void>;
    deleteContract(script: string): Promise<void>;
    private addFilterCondition;
}

export { type SQLExecutor, SQLiteContractRepository, SQLiteWalletRepository };
