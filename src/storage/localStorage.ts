export interface StorageAdapter {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    clear(): Promise<void>;
}

export class LocalStorageAdapter implements StorageAdapter {
    async getItem(key: string): Promise<string | null> {
        if (typeof window === "undefined" || !window.localStorage) {
            throw new Error(
                "localStorage is not available in this environment"
            );
        }
        return window.localStorage.getItem(key);
    }

    async setItem(key: string, value: string): Promise<void> {
        if (typeof window === "undefined" || !window.localStorage) {
            throw new Error(
                "localStorage is not available in this environment"
            );
        }
        window.localStorage.setItem(key, value);
    }

    async removeItem(key: string): Promise<void> {
        if (typeof window === "undefined" || !window.localStorage) {
            throw new Error(
                "localStorage is not available in this environment"
            );
        }
        window.localStorage.removeItem(key);
    }

    async clear(): Promise<void> {
        if (typeof window === "undefined" || !window.localStorage) {
            throw new Error(
                "localStorage is not available in this environment"
            );
        }
        window.localStorage.clear();
    }
}
