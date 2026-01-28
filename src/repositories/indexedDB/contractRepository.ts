import { ContractFilter, ContractRepository } from "../contractRepository";
import { DEFAULT_DB_NAME } from "../../wallet/serviceWorker/utils";
import {
    openDatabase,
    closeDatabase,
    STORE_CONTRACTS,
    LEGACY_STORE_CONTRACT_COLLECTIONS,
} from "./db";
import { Contract } from "../../contracts";

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

    async getContractCollection<T>(
        contractType: string
    ): Promise<ReadonlyArray<T>> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [LEGACY_STORE_CONTRACT_COLLECTIONS],
                    "readonly"
                );
                const store = transaction.objectStore(
                    LEGACY_STORE_CONTRACT_COLLECTIONS
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
                    [LEGACY_STORE_CONTRACT_COLLECTIONS],
                    "readwrite"
                );
                const store = transaction.objectStore(
                    LEGACY_STORE_CONTRACT_COLLECTIONS
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

    async clear(): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACTS, LEGACY_STORE_CONTRACT_COLLECTIONS],
                    "readwrite"
                );
                const contractDataStore =
                    transaction.objectStore(STORE_CONTRACTS);
                const collectionsStore = transaction.objectStore(
                    LEGACY_STORE_CONTRACT_COLLECTIONS
                );
                const contractsStore = transaction.objectStore(STORE_CONTRACTS);

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

    async getContracts(filter?: ContractFilter): Promise<Contract[]> {
        try {
            const db = await this.getDB();
            const store = db
                .transaction([STORE_CONTRACTS], "readonly")
                .objectStore(STORE_CONTRACTS);

            if (!filter || Object.keys(filter).length === 0) {
                return new Promise((resolve, reject) => {
                    const request = store.getAll();
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () =>
                        resolve((request.result ?? []) as Contract[]);
                });
            }

            const normalizedFilter = normalizeFilter(filter);

            // first by ID
            if (normalizedFilter.has("id")) {
                const ids = normalizedFilter.get("id")!;
                const contracts = await Promise.all(
                    ids.map(
                        (id) =>
                            new Promise<Contract>((resolve, reject) => {
                                const req = store.get(id);
                                req.onerror = () => reject(req.error);
                                req.onsuccess = () =>
                                    resolve(req.result as Contract);
                            })
                    )
                );
                return this.applyContractFilter(contracts, normalizedFilter);
            }

            // second by script, still an index
            if (normalizedFilter.has("script")) {
                const contracts = await this.getContractsByIndexValues(
                    store,
                    "script",
                    normalizedFilter.get("script")!
                );
                return this.applyContractFilter(contracts, normalizedFilter);
            }

            // by state, still an index
            if (normalizedFilter.has("state")) {
                const contracts = await this.getContractsByIndexValues(
                    store,
                    "state",
                    normalizedFilter.get("state")!
                );
                return this.applyContractFilter(contracts, normalizedFilter);
            }

            // by type, still an index
            if (normalizedFilter.has("type")) {
                const contracts = await this.getContractsByIndexValues(
                    store,
                    "type",
                    normalizedFilter.get("type")!
                );
                return this.applyContractFilter(contracts, normalizedFilter);
            }

            // any other filtering happens in-memory
            const allContracts = await new Promise<Contract[]>(
                (resolve, reject) => {
                    const request = store.getAll();
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () =>
                        resolve((request.result ?? []) as Contract[]);
                }
            );
            return this.applyContractFilter(allContracts, normalizedFilter);
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
                    [STORE_CONTRACTS],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_CONTRACTS);
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
                    [STORE_CONTRACTS],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_CONTRACTS);
                const request = store.delete(id);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve();
            });
        } catch (error) {
            console.error(`Failed to delete contract ${id}:`, error);
            throw error;
        }
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
        filter: ReturnType<typeof normalizeFilter>
    ): Contract[] {
        return contracts.filter((contract) => {
            if (filter.has("id") && !filter.get("id")?.includes(contract.id))
                return false;
            if (
                filter.has("script") &&
                !filter.get("script")?.includes(contract.script)
            )
                return false;
            if (
                filter.has("state") &&
                !filter.get("state")?.includes(contract.state)
            )
                return false;
            if (
                filter.has("type") &&
                !filter.get("type")?.includes(contract.type)
            )
                return false;
            return true;
        });
    }

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
}

const FILTER_FIELDS = [
    "id",
    "script",
    "state",
    "type",
] as (keyof ContractFilter)[];

// Transform all filter fields into an array of values
function normalizeFilter(filter: ContractFilter) {
    const res = new Map<keyof ContractFilter, string[]>();
    FILTER_FIELDS.forEach((current) => {
        if (!filter?.[current]) return;
        if (Array.isArray(filter[current])) {
            res.set(current, filter[current]);
        } else {
            res.set(current, [filter[current]]);
        }
    });
    return res;
}
