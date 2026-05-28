import { S as StorageAdapter } from '../index-C0IanN1m.cjs';

/**
 * @deprecated Use repository implementations via `StorageConfig` instead.
 */
declare class IndexedDBStorageAdapter implements StorageAdapter {
    private dbName;
    private version;
    private db;
    constructor(dbName: string, version?: number);
    private getDB;
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    clear(): Promise<void>;
}

export { IndexedDBStorageAdapter, StorageAdapter };
