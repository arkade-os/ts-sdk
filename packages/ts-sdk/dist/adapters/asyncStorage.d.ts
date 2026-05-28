import { S as StorageAdapter } from '../index-C0IanN1m.js';

/**
 * @deprecated Use repositories instead
 * Note: This requires @react-native-async-storage/async-storage to be installed
 */
declare class AsyncStorageAdapter implements StorageAdapter {
    private AsyncStorage;
    constructor();
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    clear(): Promise<void>;
}

export { AsyncStorageAdapter, StorageAdapter };
