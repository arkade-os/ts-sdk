import { StorageAdapter } from "../../storage";
import { ContractRepository } from "../contractRepository";

const getContractStorageKey = (id: string, key: string) =>
    `contract:${id}:${key}`;
const getCollectionStorageKey = (type: string) => `collection:${type}`;

export class ContractRepositoryImpl implements ContractRepository {
    private storage: StorageAdapter;

    constructor(storage: StorageAdapter) {
        this.storage = storage;
    }

    async getContractData<T>(
        contractId: string,
        key: string
    ): Promise<T | null> {
        const stored = await this.storage.getItem(
            getContractStorageKey(contractId, key)
        );
        if (!stored) return null;

        try {
            const data = JSON.parse(stored) as T;
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
        try {
            await this.storage.setItem(
                getContractStorageKey(contractId, key),
                JSON.stringify(data)
            );
        } catch (error) {
            console.error(
                `Failed to persist contract data for ${contractId}:${key}:`,
                error
            );
            throw error; // Rethrow to notify caller of failure
        }
    }

    async deleteContractData(contractId: string, key: string): Promise<void> {
        try {
            await this.storage.removeItem(
                getContractStorageKey(contractId, key)
            );
        } catch (error) {
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
        const stored = await this.storage.getItem(
            getCollectionStorageKey(contractType)
        );
        if (!stored) return [];

        try {
            const collection = JSON.parse(stored) as T[];
            return collection;
        } catch (error) {
            console.error(
                `Failed to parse contract collection ${contractType}:`,
                error
            );
            return [];
        }
    }

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

        try {
            await this.storage.setItem(
                getCollectionStorageKey(contractType),
                JSON.stringify(newCollection)
            );
        } catch (error) {
            console.error(
                `Failed to persist contract collection ${contractType}:`,
                error
            );
            throw error; // Rethrow to notify caller of failure
        }
    }

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

        try {
            await this.storage.setItem(
                getCollectionStorageKey(contractType),
                JSON.stringify(filtered)
            );
        } catch (error) {
            console.error(
                `Failed to persist contract collection removal for ${contractType}:`,
                error
            );
            throw error; // Rethrow to notify caller of failure
        }
    }

    // used only for tests
    async clearContractData(): Promise<void> {
        await this.storage.clear();
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // deprecated StorageAdapter doesn't have a `close()` method
        return;
    }
}
