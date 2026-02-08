import { DB_VERSION, STORE_CONTRACTS } from "./db";
import { Contract } from "../../contracts";
import { ContractFilter, ContractRepository } from "../contractRepository";
import { closeDatabase, openDatabase } from "../../db/manager";
import { initDatabase } from "./schema";
import { DEFAULT_DB_NAME } from "../../wallet/serviceWorker/utils";

/**
 * IndexedDB-based implementation of ContractRepository.
 *
 * Data is stored as JSON strings in key/value stores.
 */
export class IndexedDBContractRepository implements ContractRepository {
    private db: IDBDatabase | null = null;

    constructor(private readonly dbName: string = DEFAULT_DB_NAME) {}

    async clear(): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACTS],
                    "readwrite"
                );
                const contractDataStore =
                    transaction.objectStore(STORE_CONTRACTS);
                const contractsStore = transaction.objectStore(STORE_CONTRACTS);

                const contractDataRequest = contractDataStore.clear();
                const contractsRequest = contractsStore.clear();

                let completed = 0;
                const checkComplete = () => {
                    completed++;
                    if (completed === 2) {
                        resolve();
                    }
                };

                contractDataRequest.onsuccess = checkComplete;
                contractsRequest.onsuccess = checkComplete;

                contractDataRequest.onerror = () =>
                    reject(contractDataRequest.error);
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
                    request.onsuccess = () => resolve(request.result ?? []);
                });
            }

            const normalizedFilter = normalizeFilter(filter);

            // first by script, primary key
            if (normalizedFilter.has("script")) {
                const scripts = normalizedFilter.get("script")!;
                const contracts = await Promise.all(
                    scripts.map(
                        (script) =>
                            new Promise<Contract | undefined>(
                                (resolve, reject) => {
                                    const req = store.get(script);
                                    req.onerror = () => reject(req.error);
                                    req.onsuccess = () => resolve(req.result);
                                }
                            )
                    )
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

            // by layer, still an index
            if (normalizedFilter.has("layer")) {
                const contracts = await this.getContractsByIndexValues(
                    store,
                    "layer",
                    normalizedFilter.get("layer")!
                );
                return this.applyContractFilter(contracts, normalizedFilter);
            }

            // any other filtering happens in-memory
            const allContracts = await new Promise<Contract[]>(
                (resolve, reject) => {
                    const request = store.getAll();
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => resolve(request.result ?? []);
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

    async deleteContract(script: string): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_CONTRACTS],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_CONTRACTS);
                const getRequest = store.get(script);

                getRequest.onerror = () => reject(getRequest.error);
                getRequest.onsuccess = () => {
                    const request = store.delete(script);

                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => resolve();
                };
            });
        } catch (error) {
            console.error(`Failed to delete contract ${script}:`, error);
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
                    request.onsuccess = () => resolve(request.result ?? []);
                })
        );
        return Promise.all(requests).then((results) =>
            results.flatMap((result) => result)
        );
    }

    private applyContractFilter(
        // can filter directly the result of a query
        contracts: (Contract | undefined)[],
        filter: ReturnType<typeof normalizeFilter>
    ): Contract[] {
        return contracts.filter((contract) => {
            if (contract === undefined) return false;
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
            if (
                filter.has("layer") &&
                !filter.get("layer")?.includes(contract.layer)
            )
                return false;
            return true;
        }) as Contract[];
    }

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;
        this.db = await openDatabase(this.dbName, DB_VERSION, initDatabase);
        return this.db;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.db) return;
        await closeDatabase(this.dbName);
        this.db = null;
    }
}

const FILTER_FIELDS = [
    "script",
    "state",
    "type",
    "layer",
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
