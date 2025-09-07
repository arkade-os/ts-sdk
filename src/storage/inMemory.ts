export interface StorageAdapter {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    clear(): Promise<void>;
}

export class InMemoryStorageAdapter implements StorageAdapter {
    private store: Map<string, string> = new Map();

    async getItem(key: string): Promise<string | null> {
        return this.store.get(key) || null;
    }

    async setItem(key: string, value: string): Promise<void> {
        this.store.set(key, value);
    }

    async removeItem(key: string): Promise<void> {
        this.store.delete(key);
    }

    async clear(): Promise<void> {
        this.store.clear();
    }
}
