import { StorageAdapter } from "../storage";

export interface ContractRepository {
    // Generic contract metadata (for SDK users like boltz-swap)
    getContractData<T>(contractId: string, key: string): Promise<T | null>;
    setContractData<T>(contractId: string, key: string, data: T): Promise<void>;
    deleteContractData(contractId: string, key: string): Promise<void>;

    // Contract collections (following boltz-swap pattern)
    getContractCollection<T>(contractType: string): Promise<T[]>;
    saveToContractCollection<T>(
        contractType: string,
        item: T,
        idField: string
    ): Promise<void>;
    removeFromContractCollection(
        contractType: string,
        id: string,
        idField: string
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
        this.cache.set(storageKey, data);
        await this.storage.setItem(storageKey, JSON.stringify(data));
    }

    async deleteContractData(contractId: string, key: string): Promise<void> {
        const storageKey = `contract:${contractId}:${key}`;
        this.cache.delete(storageKey);
        await this.storage.removeItem(storageKey);
    }

    async getContractCollection<T>(contractType: string): Promise<T[]> {
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

    async saveToContractCollection<T>(
        contractType: string,
        item: T,
        idField: string
    ): Promise<void> {
        const collection = await this.getContractCollection<T>(contractType);
        const itemId = (item as any)[idField];
        const existing = collection.findIndex(
            (i) => (i as any)[idField] === itemId
        );

        if (existing !== -1) {
            collection[existing] = item;
        } else {
            collection.push(item);
        }

        const storageKey = `collection:${contractType}`;
        this.cache.set(storageKey, collection);
        await this.storage.setItem(storageKey, JSON.stringify(collection));
    }

    async removeFromContractCollection(
        contractType: string,
        id: string,
        idField: string
    ): Promise<void> {
        const collection = await this.getContractCollection(contractType);
        const filtered = collection.filter(
            (item) => (item as any)[idField] !== id
        );

        const storageKey = `collection:${contractType}`;
        this.cache.set(storageKey, filtered);
        await this.storage.setItem(storageKey, JSON.stringify(filtered));
    }
}
