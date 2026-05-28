import { S as StorageAdapter } from '../index-C0IanN1m.js';

/**
 * @deprecated Use repository implementations via `StorageConfig` instead.
 */
declare class FileSystemStorageAdapter implements StorageAdapter {
    private readonly basePath;
    constructor(dirPath: string);
    private validateAndGetFilePath;
    private ensureDirectory;
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    clear(): Promise<void>;
}

export { FileSystemStorageAdapter, StorageAdapter };
