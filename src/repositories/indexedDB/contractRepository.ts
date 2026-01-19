import { ContractRepository } from "../contractRepository";
import { DEFAULT_DB_NAME } from "../../wallet/serviceWorker/utils";
import {
    openDatabase,
    closeDatabase,
    STORE_CONTRACT_DATA,
    STORE_COLLECTIONS,
} from "./db";
import type { OpenDatabaseOptions } from "./db";
import { InMemoryDatabase } from "./inMemoryDatabase";

/**
 * IndexedDB-based implementation of ContractRepository.
 *
 * This repository stores contract data and collections in IndexedDB with optimized
 * indexes for complex queries. It supports automatic migration from the legacy storage
 * format (version 1) to the new indexed format (version 2).
 *
 * @example
 * ```typescript
 * const repository = new IndexedDBContractRepository('my-wallet-db');
 * await repository.setContractData('contract-id', 'key', data);
 * const data = await repository.getContractData('contract-id', 'key');
 * ```
 */
export class IndexedDBContractRepository implements ContractRepository {
    private db: IDBDatabase | null = null;
    private inMemoryDb: InMemoryDatabase | null = null;

    constructor(
        private readonly dbName: string = DEFAULT_DB_NAME,
        private readonly options?: OpenDatabaseOptions
    ) {}

    static async create(
        dbName: string = DEFAULT_DB_NAME,
        options?: OpenDatabaseOptions
    ): Promise<IndexedDBContractRepository> {
        const repository = new IndexedDBContractRepository(dbName, options);
        if (!options?.inMemory) {
            await repository.getDB();
        }
        return repository;
    }

    private async getDB(): Promise<IDBDatabase> {
        if (this.options?.inMemory) {
            throw new Error(
                "IndexedDB is not available for in-memory repositories"
            );
        }
        if (this.db) return this.db;
        this.db = await openDatabase(this.dbName, this.options);
        return this.db;
    }

    private getInMemoryDb(): InMemoryDatabase {
        if (!this.options?.inMemory) {
            throw new Error("In-memory database not enabled");
        }
        if (!this.inMemoryDb) {
            this.inMemoryDb = new InMemoryDatabase();
        }
        return this.inMemoryDb;
    }

    async close(): Promise<void> {
        if (this.options?.inMemory) {
            this.inMemoryDb = null;
            return;
        }
        if (!this.db) return;
        closeDatabase(this.dbName, this.db);
        this.db.close();
        this.db = null;
    }

    [Symbol.dispose](): void {
        void this.close();
    }

    [Symbol.asyncDispose](): Promise<void> {
        return this.close();
    }

    // Generic contract metadata
    async getContractData<T>(
        contractId: string,
        key: string
    ): Promise<T | null> {
        try {
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                const result = db.get<{ data?: T }>(STORE_CONTRACT_DATA, [
                    contractId,
                    key,
                ]);
                return result?.data ?? null;
            }
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACT_DATA],
                    "readonly"
                );
                const store = transaction.objectStore(STORE_CONTRACT_DATA);
                const request = store.get([contractId, key]);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const result = request.result;
                    if (result && result.data !== undefined) {
                        resolve(result.data as T);
                    } else {
                        resolve(null);
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
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                db.put(STORE_CONTRACT_DATA, { contractId, key, data });
                return;
            }
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACT_DATA],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_CONTRACT_DATA);
                const item = {
                    contractId,
                    key,
                    data,
                };
                const request = store.put(item);

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
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                db.delete(STORE_CONTRACT_DATA, [contractId, key]);
                return;
            }
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACT_DATA],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_CONTRACT_DATA);
                const request = store.delete([contractId, key]);

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
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                db.clear(STORE_CONTRACT_DATA);
                db.clear(STORE_COLLECTIONS);
                return;
            }
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACT_DATA, STORE_COLLECTIONS],
                    "readwrite"
                );
                const contractDataStore =
                    transaction.objectStore(STORE_CONTRACT_DATA);
                const collectionsStore =
                    transaction.objectStore(STORE_COLLECTIONS);

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

    // Contract collections
    async getContractCollection<T>(
        contractType: string
    ): Promise<ReadonlyArray<T>> {
        try {
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                const result = db.get<{ items?: ReadonlyArray<T> }>(
                    STORE_COLLECTIONS,
                    contractType
                );
                return result?.items ?? [];
            }
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_COLLECTIONS],
                    "readonly"
                );
                const store = transaction.objectStore(STORE_COLLECTIONS);
                const request = store.get(contractType);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const result = request.result;
                    if (result && result.items) {
                        resolve(result.items as ReadonlyArray<T>);
                    } else {
                        resolve([]);
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
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                const existing =
                    db.get<{ items?: T[] }>(STORE_COLLECTIONS, contractType)
                        ?.items || [];
                const existingIndex = existing.findIndex(
                    (i) => i[idField] === itemId
                );
                const collection =
                    existingIndex !== -1
                        ? existing.map((entry, index) =>
                              index === existingIndex ? item : entry
                          )
                        : [...existing, item];
                db.put(STORE_COLLECTIONS, {
                    contractType,
                    items: collection,
                });
                return;
            }
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_COLLECTIONS],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_COLLECTIONS);
                const getRequest = store.get(contractType);

                getRequest.onsuccess = () => {
                    const existing = getRequest.result;
                    let collection: T[] = existing?.items || [];

                    // Find existing item index
                    const existingIndex = collection.findIndex(
                        (i) => i[idField] === itemId
                    );

                    // Update or add item
                    if (existingIndex !== -1) {
                        collection[existingIndex] = item;
                    } else {
                        collection = [...collection, item];
                    }

                    const putRequest = store.put({
                        contractType,
                        items: collection,
                    });

                    putRequest.onsuccess = () => resolve();
                    putRequest.onerror = () => reject(putRequest.error);
                };

                getRequest.onerror = () => reject(getRequest.error);
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
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                const existing =
                    db.get<{ items?: T[] }>(STORE_COLLECTIONS, contractType)
                        ?.items || [];
                const collection = existing.filter(
                    (item) => item[idField] !== id
                );
                db.put(STORE_COLLECTIONS, {
                    contractType,
                    items: collection,
                });
                return;
            }
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_COLLECTIONS],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_COLLECTIONS);
                const getRequest = store.get(contractType);

                getRequest.onsuccess = () => {
                    const existing = getRequest.result;
                    let collection: T[] = existing?.items || [];

                    // Filter out the item with the specified id
                    collection = collection.filter(
                        (item) => item[idField] !== id
                    );

                    const putRequest = store.put({
                        contractType,
                        items: collection,
                    });

                    putRequest.onsuccess = () => resolve();
                    putRequest.onerror = () => reject(putRequest.error);
                };

                getRequest.onerror = () => reject(getRequest.error);
            });
        } catch (error) {
            console.error(
                `Failed to remove from contract collection ${contractType}:`,
                error
            );
            throw error;
        }
    }
}
