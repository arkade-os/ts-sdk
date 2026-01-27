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
    STORE_CONTRACTS_V2,
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
                    [
                        STORE_CONTRACTS,
                        STORE_CONTRACT_COLLECTIONS,
                        STORE_CONTRACTS_V2,
                    ],
                    "readwrite"
                );
                const contractDataStore =
                    transaction.objectStore(STORE_CONTRACTS);
                const collectionsStore = transaction.objectStore(
                    STORE_CONTRACT_COLLECTIONS
                );
                const contractsStore =
                    transaction.objectStore(STORE_CONTRACTS_V2);

                const contractDataRequest = contractDataStore.clear();
                const collectionsRequest = collectionsStore.clear();
                const contractsRequest = contractsStore.clear();

                let completed = 0;
                const checkComplete = () => {
                    completed++;
                    if (completed === 3) {
                        resolve();
                    }
                };

                contractDataRequest.onsuccess = checkComplete;
                collectionsRequest.onsuccess = checkComplete;
                contractsRequest.onsuccess = checkComplete;

                contractDataRequest.onerror = () =>
                    reject(contractDataRequest.error);
                collectionsRequest.onerror = () =>
                    reject(collectionsRequest.error);
                contractsRequest.onerror = () => reject(contractsRequest.error);
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

    async getContracts(filter?: ContractFilter): Promise<Contract[]> {
        try {
            const db = await this.getDB();
            const store = db
                .transaction([STORE_CONTRACTS_V2], "readonly")
                .objectStore(STORE_CONTRACTS_V2);

            if (!filter || Object.keys(filter).length === 0) {
                return new Promise((resolve, reject) => {
                    const request = store.getAll();
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () =>
                        resolve((request.result ?? []) as Contract[]);
                });
            }

            if (filter.id) {
                const contract = await this.getContractById(store, filter.id);
                return contract ? [contract] : [];
            }

            if (filter.ids?.length) {
                const contracts = await Promise.all(
                    filter.ids.map((id) => this.getContractById(store, id))
                );
                return this.applyContractFilter(
                    contracts.filter(Boolean) as Contract[],
                    filter
                );
            }

            if (filter.script) {
                const contract = await this.getContractByIndex(
                    store,
                    "script",
                    filter.script
                );
                return contract
                    ? this.applyContractFilter([contract], filter)
                    : [];
            }

            if (filter.state || (filter.states && filter.states.length > 0)) {
                const states = filter.state
                    ? [filter.state]
                    : (filter.states ?? []);
                const contracts = await this.getContractsByIndexValues(
                    store,
                    "state",
                    states
                );
                return this.applyContractFilter(contracts, filter);
            }

            if (filter.type || (filter.types && filter.types.length > 0)) {
                const types = filter.type
                    ? [filter.type]
                    : (filter.types ?? []);
                const contracts = await this.getContractsByIndexValues(
                    store,
                    "type",
                    types
                );
                return this.applyContractFilter(contracts, filter);
            }

            const allContracts = await new Promise<Contract[]>(
                (resolve, reject) => {
                    const request = store.getAll();
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () =>
                        resolve((request.result ?? []) as Contract[]);
                }
            );
            return this.applyContractFilter(allContracts, filter);
        } catch (error) {
            console.error("Failed to get contracts:", error);
            return [];
        }
    }

    async saveContract(contract: Contract): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACTS_V2],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_CONTRACTS_V2);
                const request = store.put(contract);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve();
            });
        } catch (error) {
            console.error("Failed to save contract:", error);
            throw error;
        }
    }

    async deleteContract(id: string): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACTS_V2],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_CONTRACTS_V2);
                const request = store.delete(id);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve();
            });
        } catch (error) {
            console.error(`Failed to delete contract ${id}:`, error);
            throw error;
        }
    }

    private getContractById(
        store: IDBObjectStore,
        id: string
    ): Promise<Contract | undefined> {
        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onerror = () => reject(request.error);
            request.onsuccess = () =>
                resolve(request.result as Contract | undefined);
        });
    }

    private getContractByIndex(
        store: IDBObjectStore,
        indexName: string,
        value: string
    ): Promise<Contract | undefined> {
        return new Promise((resolve, reject) => {
            const index = store.index(indexName);
            const request = index.get(value);
            request.onerror = () => reject(request.error);
            request.onsuccess = () =>
                resolve(request.result as Contract | undefined);
        });
    }

    private getContractsByIndexValues(
        store: IDBObjectStore,
        indexName: string,
        values: string[]
    ): Promise<Contract[]> {
        if (values.length === 0) return Promise.resolve([]);
        const index = store.index(indexName);
        const requests = values.map(
            (value) =>
                new Promise<Contract[]>((resolve, reject) => {
                    const request = index.getAll(value);
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () =>
                        resolve((request.result ?? []) as Contract[]);
                })
        );
        return Promise.all(requests).then((results) =>
            results.flatMap((result) => result)
        );
    }

    private applyContractFilter(
        contracts: Contract[],
        filter: ContractFilter
    ): Contract[] {
        return contracts.filter((contract) => {
            if (filter.id && contract.id !== filter.id) return false;
            if (filter.ids && !filter.ids.includes(contract.id)) return false;
            if (filter.script && contract.script !== filter.script)
                return false;
            if (filter.state && contract.state !== filter.state) return false;
            if (filter.states && !filter.states.includes(contract.state)) {
                return false;
            }
            if (filter.type && contract.type !== filter.type) return false;
            if (filter.types && !filter.types.includes(contract.type)) {
                return false;
            }
            return true;
        });
    }
}
