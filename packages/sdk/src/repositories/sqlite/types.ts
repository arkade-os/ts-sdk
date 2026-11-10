/**
 * Minimal SQL execution interface that consumers implement
 * to connect their SQLite (or any SQL) database to the SDK.
 * Share one executor object per connection across SDK repositories; separate wrappers
 * and direct raw-driver calls bypass the SDK operation queue.
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
export interface SQLExecutor {
    run(sql: string, params?: unknown[]): Promise<void>;
    get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
    all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}
