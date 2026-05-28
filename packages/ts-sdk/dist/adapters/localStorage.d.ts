import { S as StorageAdapter } from '../index-C0IanN1m.js';

/**
 * @deprecated Use repository implementations via `StorageConfig` instead.
 */
declare class LocalStorageAdapter implements StorageAdapter {
    private getSafeLocalStorage;
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    clear(): Promise<void>;
}

export { LocalStorageAdapter, StorageAdapter };
