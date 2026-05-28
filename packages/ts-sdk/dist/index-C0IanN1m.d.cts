/**
 * @deprecated Use `StorageConfig` with repository implementations such as `IndexedDBWalletRepository` and `IndexedDBContractRepository` instead.
 */
interface StorageAdapter {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    clear(): Promise<void>;
}

export type { StorageAdapter as S };
