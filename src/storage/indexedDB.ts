import type { StorageAdapter } from "./index";

export class IndexedDBStorageAdapter implements StorageAdapter {
    private dbName: string;
    private version: number;
    private db: IDBDatabase | null = null;

    constructor(dbName: string, version: number = 1) {
        this.dbName = dbName;
        this.version = version;
    }

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;

        if (typeof window === "undefined" || !window.indexedDB) {
            throw new Error("IndexedDB is not available in this environment");
        }

        return new Promise((resolve, reject) => {
            const request = window.indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains("storage")) {
                    db.createObjectStore("storage");
                }
            };
        });
    }

    async getItem(key: string): Promise<string | null> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(["storage"], "readonly");
                const store = transaction.objectStore("storage");
                const request = store.get(key);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    resolve(request.result || null);
                };
            });
        } catch (error) {
            console.error(`Failed to get item for key ${key}:`, error);
            return null;
        }
    }

    async setItem(key: string, value: string): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(["storage"], "readwrite");
                const store = transaction.objectStore("storage");
                const request = store.put(value, key);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve();
            });
        } catch (error) {
            console.error(`Failed to set item for key ${key}:`, error);
            throw error;
        }
    }

    async removeItem(key: string): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(["storage"], "readwrite");
                const store = transaction.objectStore("storage");
                const request = store.delete(key);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve();
            });
        } catch (error) {
            console.error(`Failed to remove item for key ${key}:`, error);
        }
    }

    async clear(): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(["storage"], "readwrite");
                const store = transaction.objectStore("storage");
                const request = store.clear();

                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve();
            });
        } catch (error) {
            console.error("Failed to clear storage:", error);
        }
    }
}
