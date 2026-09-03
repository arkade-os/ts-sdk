import { DB_VERSION, STORE_CONTRACTS } from "./db";
import { Contract, watchStateOf } from "../../contracts";
import { ContractFilter, ContractRepository } from "../contractRepository";
import { awaitTransaction, getAllByIndexValues, promisifyRequest } from "./idbUtils";
import { createManagedConnection, ManagedConnection } from "./managedConnection";
import { initDatabase } from "./schema";
import { DEFAULT_DB_NAME } from "../../worker/browser/utils";

/**
 * IndexedDB-based implementation of ContractRepository.
 *
 * Data is stored as JSON strings in key/value stores.
 */
export class IndexedDBContractRepository implements ContractRepository {
    readonly version = 2 as const;
    private readonly connection: ManagedConnection;

    constructor(dbName: string = DEFAULT_DB_NAME) {
        this.connection = createManagedConnection(dbName, DB_VERSION, initDatabase);
    }

    async clear(): Promise<void> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_CONTRACTS], "readwrite");
            transaction.objectStore(STORE_CONTRACTS).clear();
            await awaitTransaction(transaction);
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
                return (await promisifyRequest<Contract[]>(store.getAll())) ?? [];
            }

            const normalizedFilter = normalizeFilter(filter);

            // first by script, primary key
            if (normalizedFilter.has("script")) {
                const scripts = normalizedFilter.get("script")!;
                const contracts = await Promise.all(
                    scripts.map((script) =>
                        promisifyRequest<Contract | undefined>(store.get(script)),
                    ),
                );
                return this.applyContractFilter(contracts, normalizedFilter);
            }

            // by state, still an index
            if (normalizedFilter.has("state")) {
                const contracts = await getAllByIndexValues<Contract>(
                    store,
                    "state",
                    normalizedFilter.get("state")!,
                );
                return this.applyContractFilter(contracts, normalizedFilter);
            }

            // by type, still an index
            if (normalizedFilter.has("type")) {
                const contracts = await getAllByIndexValues<Contract>(
                    store,
                    "type",
                    normalizedFilter.get("type")!,
                );
                return this.applyContractFilter(contracts, normalizedFilter);
            }

            // any other filtering happens in-memory
            const allContracts = (await promisifyRequest<Contract[]>(store.getAll())) ?? [];
            return this.applyContractFilter(allContracts, normalizedFilter);
        } catch (error) {
            console.error("Failed to get contracts:", error);
            return [];
        }
    }

    async saveContract(contract: Contract): Promise<void> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_CONTRACTS], "readwrite");
            transaction.objectStore(STORE_CONTRACTS).put(contract);
            await awaitTransaction(transaction);
        } catch (error) {
            console.error("Failed to save contract:", error);
            throw error;
        }
    }

    async deleteContract(script: string): Promise<void> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_CONTRACTS], "readwrite");
            transaction.objectStore(STORE_CONTRACTS).delete(script);
            await awaitTransaction(transaction);
        } catch (error) {
            console.error(`Failed to delete contract ${script}:`, error);
            throw error;
        }
    }

    private applyContractFilter(
        // can filter directly the result of a query
        contracts: (Contract | undefined)[],
        filter: ReturnType<typeof normalizeFilter>,
    ): Contract[] {
        return contracts.filter((contract) => {
            if (contract === undefined) return false;
            if (filter.has("script") && !filter.get("script")?.includes(contract.script))
                return false;
            if (filter.has("state") && !filter.get("state")?.includes(contract.state)) return false;
            if (filter.has("type") && !filter.get("type")?.includes(contract.type)) return false;
            // Whole objects are stored, so a row written before the field
            // existed simply has none — `watchStateOf` supplies the default.
            if (filter.has("watch") && !filter.get("watch")?.includes(watchStateOf(contract)))
                return false;
            return true;
        }) as Contract[];
    }

    private getDB(): Promise<IDBDatabase> {
        return this.connection.get();
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.connection[Symbol.asyncDispose]();
    }
}

// `watch` has no index — it is filtered in memory by `applyContractFilter`,
// after whichever indexed field narrowed the read.
const FILTER_FIELDS = ["script", "state", "type", "watch"] as (keyof ContractFilter)[];

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
