export interface StorageAdapter {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    clear(): Promise<void>;
}

export * from "./inMemory";
export * from "./indexedDB";
export * from "./vtxoRepository";
