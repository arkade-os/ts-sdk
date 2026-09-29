import { DB_VERSION, STORE_CONTRACTS } from "./db";
import { Contract, watchStateOf } from "../../contracts";
import { ContractFilter, ContractRepository } from "../contractRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";
import { awaitTransaction, promisifyRequest } from "./idbUtils";
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

    async getContractsPage(
        filter: ContractFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<Contract>> {
        assertPageRequest(page);
        const db = await this.getDB();
        const store = db.transaction([STORE_CONTRACTS], "readonly").objectStore(STORE_CONTRACTS);
        const normalized = normalizeFilter(filter ?? {});
        const scripts = normalized.get("script");
        if (scripts) {
            const keys = [...new Set(scripts)]
                .filter((script) => page.after === undefined || script > page.after)
                .sort();
            const contracts = await Promise.all(
                keys.map((script) => promisifyRequest<Contract | undefined>(store.get(script))),
            );
            return pageResult(
                this.applyContractFilter(contracts, normalized),
                page.limit,
                (contract) => contract.script,
            );
        }
        const range =
            page.after === undefined ? undefined : IDBKeyRange.lowerBound(page.after, true);
        const cursorRequest = store.openCursor(range);
        return new Promise((resolve, reject) => {
            const rows: Contract[] = [];
            cursorRequest.onerror = () => reject(cursorRequest.error);
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor) {
                    resolve(pageResult(rows, page.limit, (contract) => contract.script));
                    return;
                }
                if (this.applyContractFilter([cursor.value as Contract], normalized).length) {
                    rows.push(cursor.value as Contract);
                }
                if (rows.length > page.limit) {
                    resolve(pageResult(rows, page.limit, (contract) => contract.script));
                    return;
                }
                cursor.continue();
            };
        });
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
