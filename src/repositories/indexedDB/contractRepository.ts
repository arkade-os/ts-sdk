import {
    ContractFilter,
    ContractRepository,
    CONTRACTS_COLLECTION,
} from "../contractRepository";
import { DEFAULT_DB_NAME } from "../../wallet/serviceWorker/utils";
import {
    openDatabase,
    closeDatabase,
    STORE_CONTRACTS,
    STORE_CONTRACT_COLLECTIONS,
} from "./db";
import { Contract } from "../../contracts";

export const contractKey = (contractId: string, key: string) =>
    `contract:${contractId}:${key}`;
export const collectionKey = (contractType: string) =>
    `collection:${contractType}`;

/**
 * IndexedDB-based implementation of ContractRepository.
 *
 * Data is stored as JSON strings in key/value stores.
 */
export class IndexedDBContractRepository implements ContractRepository {
    private db: IDBDatabase | null = null;

    constructor(private readonly dbName: string = DEFAULT_DB_NAME) {}

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;
        this.db = await openDatabase(this.dbName);
        return this.db;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.db) return;
        await closeDatabase(this.dbName);
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

    // Contract entity management methods

    async getContracts(filter?: ContractFilter): Promise<Contract[]> {
        const contracts =
            await this.getContractCollection<Contract>(CONTRACTS_COLLECTION);

        if (!filter) {
            return [...contracts];
        }

        return contracts.filter((c) => {
            // Filter by ID
            if (filter.id !== undefined && c.id !== filter.id) {
                return false;
            }

            // Filter by multiple IDs
            if (filter.ids !== undefined && !filter.ids.includes(c.id)) {
                return false;
            }

            // Filter by script
            if (filter.script !== undefined && c.script !== filter.script) {
                return false;
            }

            // Filter by state(s)
            if (filter.state !== undefined) {
                const states = Array.isArray(filter.state)
                    ? filter.state
                    : [filter.state];
                if (!states.includes(c.state)) {
                    return false;
                }
            }

            return true;
        });
    }

    async saveContract(contract: Contract): Promise<void> {
        await this.saveToContractCollection(
            CONTRACTS_COLLECTION,
            contract,
            "id"
        );
    }

    async deleteContract(id: string): Promise<void> {
        await this.removeFromContractCollection<Contract, "id">(
            CONTRACTS_COLLECTION,
            id,
            "id"
        );
    }
}
