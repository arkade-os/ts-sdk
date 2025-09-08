export interface StorageAdapter {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
    clear(): Promise<void>;
}

// Note: This requires @react-native-async-storage/async-storage to be installed
export class AsyncStorageAdapter implements StorageAdapter {
    private AsyncStorage: any;

    constructor() {
        try {
            // Dynamic import to avoid errors in non-React Native environments
            this.AsyncStorage =
                require("@react-native-async-storage/async-storage").default;
        } catch (error) {
            throw new Error(
                "AsyncStorage is not available. Make sure @react-native-async-storage/async-storage is installed in React Native environment."
            );
        }
    }

    async getItem(key: string): Promise<string | null> {
        return await this.AsyncStorage.getItem(key);
    }

    async setItem(key: string, value: string): Promise<void> {
        try {
            await this.AsyncStorage.setItem(key, value);
        } catch (error) {
            console.error(`Failed to set item for key ${key}:`, error);
            throw error;
        }
    }

    async removeItem(key: string): Promise<void> {
        try {
            await this.AsyncStorage.removeItem(key);
        } catch (error) {
            console.error(`Failed to remove item for key ${key}:`, error);
            throw error;
        }
    }

    async clear(): Promise<void> {
        try {
            await this.AsyncStorage.clear();
        } catch (error) {
            console.error("Failed to clear AsyncStorage:", error);
            throw error;
        }
    }
}
