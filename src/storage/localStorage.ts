import type { StorageAdapter } from "./index";

export class LocalStorageAdapter implements StorageAdapter {
    private getSafeLocalStorage(): Storage | null {
        try {
            if (typeof window === "undefined" || !window.localStorage) {
                return null;
            }
            // Test access to ensure localStorage is actually available
            window.localStorage.length;
            return window.localStorage;
        } catch {
            // localStorage may throw in some environments (e.g., private browsing, disabled storage)
            return null;
        }
    }

    async getItem(key: string): Promise<string | null> {
        const localStorage = this.getSafeLocalStorage();
        if (!localStorage) {
            throw new Error(
                "localStorage is not available in this environment"
            );
        }
        return localStorage.getItem(key);
    }

    async setItem(key: string, value: string): Promise<void> {
        const localStorage = this.getSafeLocalStorage();
        if (!localStorage) {
            throw new Error(
                "localStorage is not available in this environment"
            );
        }
        localStorage.setItem(key, value);
    }

    async removeItem(key: string): Promise<void> {
        const localStorage = this.getSafeLocalStorage();
        if (!localStorage) {
            throw new Error(
                "localStorage is not available in this environment"
            );
        }
        localStorage.removeItem(key);
    }

    async clear(): Promise<void> {
        const localStorage = this.getSafeLocalStorage();
        if (!localStorage) {
            throw new Error(
                "localStorage is not available in this environment"
            );
        }
        localStorage.clear();
    }
}
