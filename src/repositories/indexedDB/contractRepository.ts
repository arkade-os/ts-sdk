import { ContractRepository } from "../contractRepository";
import { DEFAULT_DB_NAME } from "../../wallet/serviceWorker/utils";
import {
    openDatabase,
    closeDatabase,
    STORE_CONTRACTS,
    STORE_CONTRACT_COLLECTIONS,
} from "./db";
import { InMemoryDatabase } from "./inMemoryDatabase";

type ContractStore = {
    init?: () => Promise<void>;
    close: () => Promise<void>;
    getContractData: <T>(contractId: string, key: string) => Promise<T | null>;
    setContractData: <T>(
        contractId: string,
        key: string,
        data: T
    ) => Promise<void>;
    deleteContractData: (contractId: string, key: string) => Promise<void>;
    clearContractData: () => Promise<void>;
    getContractCollection: <T>(
        contractType: string
    ) => Promise<ReadonlyArray<T>>;
    saveToContractCollection: <T, K extends keyof T>(
        contractType: string,
        item: T,
        idField: K
    ) => Promise<void>;
    removeFromContractCollection: <T, K extends keyof T>(
        contractType: string,
        id: T[K],
        idField: K
    ) => Promise<void>;
};

const contractKey = (contractId: string, key: string) =>
    `contract:${contractId}:${key}`;
const collectionKey = (contractType: string) => `collection:${contractType}`;

class IndexedDbContractStore implements ContractStore {
    private db: IDBDatabase | null = null;

    constructor(private readonly dbName: string) {}

    async init(): Promise<void> {
        await this.getDB();
    }

    async close(): Promise<void> {
        if (!this.db) return;
        closeDatabase(this.dbName, this.db);
        this.db.close();
        this.db = null;
    }

    async getContractData<T>(
        contractId: string,
        key: string
    ): Promise<T | null> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACTS],
                    "readonly"
                );
                const store = transaction.objectStore(STORE_CONTRACTS);
                const request = store.get(contractKey(contractId, key));

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const result = request.result as
                        | { value?: string }
                        | undefined;
                    if (!result?.value) return resolve(null);
                    try {
                        resolve(JSON.parse(result.value) as T);
                    } catch (error) {
                        reject(error);
                    }
                };
            });
        } catch (error) {
            console.error(
                `Failed to get contract data for ${contractId}:${key}:`,
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
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACTS],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_CONTRACTS);
                const request = store.put({
                    key: contractKey(contractId, key),
                    value: JSON.stringify(data),
                });

                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve();
            });
        } catch (error) {
            console.error(
                `Failed to set contract data for ${contractId}:${key}:`,
                error
            );
            throw error;
        }
    }

    async deleteContractData(contractId: string, key: string): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACTS],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_CONTRACTS);
                const request = store.delete(contractKey(contractId, key));

                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve();
            });
        } catch (error) {
            console.error(
                `Failed to delete contract data for ${contractId}:${key}:`,
                error
            );
            throw error;
        }
    }

    async clearContractData(): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACTS, STORE_CONTRACT_COLLECTIONS],
                    "readwrite"
                );
                const contractDataStore =
                    transaction.objectStore(STORE_CONTRACTS);
                const collectionsStore = transaction.objectStore(
                    STORE_CONTRACT_COLLECTIONS
                );

                const contractDataRequest = contractDataStore.clear();
                const collectionsRequest = collectionsStore.clear();

                let completed = 0;
                const checkComplete = () => {
                    completed++;
                    if (completed === 2) {
                        resolve();
                    }
                };

                contractDataRequest.onsuccess = checkComplete;
                collectionsRequest.onsuccess = checkComplete;

                contractDataRequest.onerror = () =>
                    reject(contractDataRequest.error);
                collectionsRequest.onerror = () =>
                    reject(collectionsRequest.error);
            });
        } catch (error) {
            console.error("Failed to clear contract data:", error);
            throw error;
        }
    }

    async getContractCollection<T>(
        contractType: string
    ): Promise<ReadonlyArray<T>> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACT_COLLECTIONS],
                    "readonly"
                );
                const store = transaction.objectStore(
                    STORE_CONTRACT_COLLECTIONS
                );
                const request = store.get(collectionKey(contractType));

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const result = request.result as
                        | { value?: string }
                        | undefined;
                    if (!result?.value) return resolve([]);
                    try {
                        resolve(JSON.parse(result.value) as ReadonlyArray<T>);
                    } catch (error) {
                        reject(error);
                    }
                };
            });
        } catch (error) {
            console.error(
                `Failed to get contract collection ${contractType}:`,
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
        // Validate that the item has the required id field
        const itemId = item[idField];
        if (itemId === undefined || itemId === null) {
            throw new Error(
                `Item is missing required field '${String(idField)}'`
            );
        }

        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACT_COLLECTIONS],
                    "readwrite"
                );
                const store = transaction.objectStore(
                    STORE_CONTRACT_COLLECTIONS
                );
                const key = collectionKey(contractType);

                // Read within the same transaction
                const getRequest = store.get(key);

                getRequest.onerror = () => reject(getRequest.error);
                getRequest.onsuccess = () => {
                    try {
                        const result = getRequest.result as
                            | { value?: string }
                            | undefined;
                        const collection: T[] = result?.value
                            ? JSON.parse(result.value)
                            : [];

                        const existingIndex = collection.findIndex(
                            (i) => i[idField] === itemId
                        );
                        const updated =
                            existingIndex !== -1
                                ? collection.map((entry, index) =>
                                      index === existingIndex ? item : entry
                                  )
                                : [...collection, item];

                        // Write within the same transaction
                        const putRequest = store.put({
                            key,
                            value: JSON.stringify(updated),
                        });

                        putRequest.onerror = () => reject(putRequest.error);
                        putRequest.onsuccess = () => resolve();
                    } catch (error) {
                        reject(error);
                    }
                };
            });
        } catch (error) {
            console.error(
                `Failed to save to contract collection ${contractType}:`,
                error
            );
            throw error;
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

        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACT_COLLECTIONS],
                    "readwrite"
                );
                const store = transaction.objectStore(
                    STORE_CONTRACT_COLLECTIONS
                );
                const key = collectionKey(contractType);

                // Read within the same transaction
                const getRequest = store.get(key);

                getRequest.onerror = () => reject(getRequest.error);
                getRequest.onsuccess = () => {
                    try {
                        const result = getRequest.result as
                            | { value?: string }
                            | undefined;
                        const collection: T[] = result?.value
                            ? JSON.parse(result.value)
                            : [];

                        const filtered = collection.filter(
                            (item) => item[idField] !== id
                        );

                        // Write within the same transaction
                        const putRequest = store.put({
                            key,
                            value: JSON.stringify(filtered),
                        });

                        putRequest.onerror = () => reject(putRequest.error);
                        putRequest.onsuccess = () => resolve();
                    } catch (error) {
                        reject(error);
                    }
                };
            });
        } catch (error) {
            console.error(
                `Failed to remove from contract collection ${contractType}:`,
                error
            );
            throw error;
        }
    }

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;
        this.db = await openDatabase(this.dbName);
        return this.db;
    }
}

class InMemoryContractStore implements ContractStore {
    private db: InMemoryDatabase | null = new InMemoryDatabase();

    async close(): Promise<void> {
        this.db = null;
    }

    async getContractData<T>(
        contractId: string,
        key: string
    ): Promise<T | null> {
        const db = this.getDb();
        const result = db.get<{ value?: string }>(
            STORE_CONTRACTS,
            contractKey(contractId, key)
        );
        if (!result?.value) return null;
        return JSON.parse(result.value) as T;
    }

    async setContractData<T>(
        contractId: string,
        key: string,
        data: T
    ): Promise<void> {
        const db = this.getDb();
        db.put(STORE_CONTRACTS, {
            key: contractKey(contractId, key),
            value: JSON.stringify(data),
        });
    }

    async deleteContractData(contractId: string, key: string): Promise<void> {
        const db = this.getDb();
        db.delete(STORE_CONTRACTS, contractKey(contractId, key));
    }

    async clearContractData(): Promise<void> {
        const db = this.getDb();
        db.clear(STORE_CONTRACTS);
        db.clear(STORE_CONTRACT_COLLECTIONS);
    }

    async getContractCollection<T>(
        contractType: string
    ): Promise<ReadonlyArray<T>> {
        const db = this.getDb();
        const result = db.get<{ value?: string }>(
            STORE_CONTRACT_COLLECTIONS,
            collectionKey(contractType)
        );
        if (!result?.value) return [];
        return JSON.parse(result.value) as ReadonlyArray<T>;
    }

    async saveToContractCollection<T, K extends keyof T>(
        contractType: string,
        item: T,
        idField: K
    ): Promise<void> {
        // Validate that the item has the required id field
        const itemId = item[idField];
        if (itemId === undefined || itemId === null) {
            throw new Error(
                `Item is missing required field '${String(idField)}'`
            );
        }

        const db = this.getDb();
        const existing = await this.getContractCollection<T>(contractType);
        const existingIndex = existing.findIndex((i) => i[idField] === itemId);
        const collection =
            existingIndex !== -1
                ? existing.map((entry, index) =>
                      index === existingIndex ? item : entry
                  )
                : [...existing, item];
        db.put(STORE_CONTRACT_COLLECTIONS, {
            key: collectionKey(contractType),
            value: JSON.stringify(collection),
        });
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

        const db = this.getDb();
        const existing = await this.getContractCollection<T>(contractType);
        const collection = existing.filter((item) => item[idField] !== id);
        db.put(STORE_CONTRACT_COLLECTIONS, {
            key: collectionKey(contractType),
            value: JSON.stringify(collection),
        });
    }

    private getDb(): InMemoryDatabase {
        if (!this.db) {
            throw new Error("In-memory database has been closed");
        }
        return this.db;
    }
}

/**
 * IndexedDB-based implementation of ContractRepository.
 *
 * Pass `{ inMemory: true }` to use a simple in-memory store (per instance).
 * Data is stored as JSON strings in key/value stores.
 */
export class IndexedDBContractRepository implements ContractRepository {
    private readonly store: ContractStore;

    constructor(
        dbName: string = DEFAULT_DB_NAME,
        options?: { inMemory?: boolean }
    ) {
        this.store = options?.inMemory
            ? new InMemoryContractStore()
            : new IndexedDbContractStore(dbName);
    }

    static async create(
        dbName: string = DEFAULT_DB_NAME,
        options?: { inMemory?: boolean }
    ): Promise<IndexedDBContractRepository> {
        const repository = new IndexedDBContractRepository(dbName, options);
        await repository.store.init?.();
        return repository;
    }

    async close(): Promise<void> {
        await this.store.close();
    }

    [Symbol.dispose](): void {
        void this.close();
    }

    [Symbol.asyncDispose](): Promise<void> {
        return this.close();
    }

    getContractData<T>(contractId: string, key: string): Promise<T | null> {
        return this.store.getContractData(contractId, key);
    }

    setContractData<T>(
        contractId: string,
        key: string,
        data: T
    ): Promise<void> {
        return this.store.setContractData(contractId, key, data);
    }

    deleteContractData(contractId: string, key: string): Promise<void> {
        return this.store.deleteContractData(contractId, key);
    }

    clearContractData(): Promise<void> {
        return this.store.clearContractData();
    }

    getContractCollection<T>(contractType: string): Promise<ReadonlyArray<T>> {
        return this.store.getContractCollection(contractType);
    }

    saveToContractCollection<T, K extends keyof T>(
        contractType: string,
        item: T,
        idField: K
    ): Promise<void> {
        return this.store.saveToContractCollection(contractType, item, idField);
    }

    removeFromContractCollection<T, K extends keyof T>(
        contractType: string,
        id: T[K],
        idField: K
    ): Promise<void> {
        return this.store.removeFromContractCollection(
            contractType,
            id,
            idField
        );
    }
}
