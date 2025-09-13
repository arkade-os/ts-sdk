import { StorageAdapter } from "../storage";

export interface ContractRepository {
    // Generic contract metadata (for SDK users like boltz-swap)
    getContractData<T>(contractId: string, key: string): Promise<T | null>;
    setContractData<T>(contractId: string, key: string, data: T): Promise<void>;
    deleteContractData(contractId: string, key: string): Promise<void>;

    // Contract collections (following boltz-swap pattern) - with type-safe id fields
    getContractCollection<T>(contractType: string): Promise<ReadonlyArray<T>>;
    saveToContractCollection<T, K extends keyof T>(
        contractType: string,
        item: T,
        idField: K
    ): Promise<void>;
    removeFromContractCollection<T, K extends keyof T>(
        contractType: string,
        id: T[K],
        idField: K
    ): Promise<void>;
}

export class ContractRepositoryImpl implements ContractRepository {
    private storage: StorageAdapter;
    private cache: Map<string, any> = new Map();

    constructor(storage: StorageAdapter) {
        this.storage = storage;
    }

    async getContractData<T>(
        contractId: string,
        key: string
    ): Promise<T | null> {
        const storageKey = `contract:${contractId}:${key}`;
        const cached = this.cache.get(storageKey);
        if (cached !== undefined) return cached;

        const stored = await this.storage.getItem(storageKey);
        if (!stored) return null;

        try {
            const data = JSON.parse(stored) as T;
            this.cache.set(storageKey, data);
            return data;
        } catch (error) {
            console.error(
                `Failed to parse contract data for ${contractId}:${key}:`,
                error
            );
            return null;
        }
    }

    async setContractData<T>(
        contractId: string,
        key: string,
        data: T
    ): Promise<void> {
        const storageKey = `contract:${contractId}:${key}`;

        try {
            // First persist to storage, only update cache if successful
            await this.storage.setItem(storageKey, JSON.stringify(data));
            this.cache.set(storageKey, data);
        } catch (error) {
            // Storage operation failed, cache remains unchanged
            console.error(
                `Failed to persist contract data for ${contractId}:${key}:`,
                error
            );
            throw error; // Rethrow to notify caller of failure
        }
    }

    async deleteContractData(contractId: string, key: string): Promise<void> {
        const storageKey = `contract:${contractId}:${key}`;

        try {
            // First remove from persistent storage, only delete from cache if successful
            await this.storage.removeItem(storageKey);
            this.cache.delete(storageKey);
        } catch (error) {
            // Storage operation failed, cache remains unchanged
            console.error(
                `Failed to remove contract data for ${contractId}:${key}:`,
                error
            );
            throw error; // Rethrow to notify caller of failure
        }
    }

    async getContractCollection<T>(
        contractType: string
    ): Promise<ReadonlyArray<T>> {
        const storageKey = `collection:${contractType}`;
        const cached = this.cache.get(storageKey);
        if (cached !== undefined) return cached;

        const stored = await this.storage.getItem(storageKey);
        if (!stored) {
            this.cache.set(storageKey, []);
            return [];
        }

        try {
            const collection = JSON.parse(stored) as T[];
            this.cache.set(storageKey, collection);
            return collection;
        } catch (error) {
            console.error(
                `Failed to parse contract collection ${contractType}:`,
                error
            );
            this.cache.set(storageKey, []);
            return [];
        }
    }

    /**
     * Saves an item to a contract collection, either adding it as new or replacing an existing item.
     *
     * @warning **NOT THREAD-SAFE**: This method uses a read-modify-write pattern that can cause
     * lost updates under concurrent access. If multiple operations modify the same collection
     * simultaneously, some updates may be lost. For concurrent environments, consider implementing
     * proper synchronization or optimistic locking mechanisms.
     *
     * @template T - The type of items in the collection
     * @template K - The key type used to identify items
     * @param contractType - The type/name of the contract collection
     * @param item - The item to save (must include the id field)
     * @param idField - The field name used as unique identifier for items
     * @throws {Error} If the item is missing the required id field
     * @throws {Error} If storage persistence fails
     */
    async saveToContractCollection<T, K extends keyof T>(
        contractType: string,
        item: T,
        idField: K
    ): Promise<void> {
        const collection = await this.getContractCollection<T>(contractType);

        // Validate that the item has the required id field
        const itemId = item[idField];
        if (itemId === undefined || itemId === null) {
            throw new Error(
                `Item is missing required field '${String(idField)}'`
            );
        }

        // Find existing item index without mutating the original collection
        const existingIndex = collection.findIndex(
            (i) => i[idField] === itemId
        );

        // Build new collection without mutating the cached one
        let newCollection: T[];
        if (existingIndex !== -1) {
            // Replace existing item
            newCollection = [
                ...collection.slice(0, existingIndex),
                item,
                ...collection.slice(existingIndex + 1),
            ];
        } else {
            // Add new item
            newCollection = [...collection, item];
        }

        const storageKey = `collection:${contractType}`;

        try {
            // First persist to storage, only update cache if successful
            await this.storage.setItem(
                storageKey,
                JSON.stringify(newCollection)
            );
            this.cache.set(storageKey, newCollection);
        } catch (error) {
            // Storage operation failed, cache remains unchanged
            console.error(
                `Failed to persist contract collection ${contractType}:`,
                error
            );
            throw error; // Rethrow to notify caller of failure
        }
    }

    /**
     * Removes an item from a contract collection by its identifier.
     *
     * @warning **NOT THREAD-SAFE**: This method uses a read-modify-write pattern that can cause
     * lost updates under concurrent access. If multiple operations modify the same collection
     * simultaneously, some updates may be lost. For concurrent environments, consider implementing
     * proper synchronization or optimistic locking mechanisms.
     *
     * @template T - The type of items in the collection
     * @template K - The key type used to identify items
     * @param contractType - The type/name of the contract collection
     * @param id - The identifier of the item to remove
     * @param idField - The field name used as unique identifier for items
     * @throws {Error} If the id parameter is undefined or null
     * @throws {Error} If storage persistence fails
     */
    async removeFromContractCollection<T, K extends keyof T>(
        contractType: string,
        id: T[K],
        idField: K
    ): Promise<void> {
        // Validate input parameters
        if (id === undefined || id === null) {
            throw new Error(`Invalid id provided for removal: ${String(id)}`);
        }

        const collection = await this.getContractCollection<T>(contractType);

        // Build new collection without the specified item
        const filtered = collection.filter((item) => item[idField] !== id);

        const storageKey = `collection:${contractType}`;

        try {
            // First persist to storage, only update cache if successful
            await this.storage.setItem(storageKey, JSON.stringify(filtered));
            this.cache.set(storageKey, filtered);
        } catch (error) {
            // Storage operation failed, cache remains unchanged
            console.error(
                `Failed to persist contract collection removal for ${contractType}:`,
                error
            );
            throw error; // Rethrow to notify caller of failure
        }
    }
}
