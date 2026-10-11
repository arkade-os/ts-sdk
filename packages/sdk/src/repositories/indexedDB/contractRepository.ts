import { Contract, watchStateOf } from "../../contracts";
import { ContractFilter, ContractRepository } from "../contractRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";
import { awaitTransaction, promisifyRequest } from "./idbUtils";
import { createManagedConnection, ManagedConnection } from "./managedConnection";
import {
    CONTRACT_TYPE_WATCH_INDEX,
    CONTRACT_WATCH_INDEX,
    contractRow,
    type ContractRow,
    DB_VERSION,
    initDatabase,
    STORE_CONTRACTS,
} from "./schema";
import { DEFAULT_DB_NAME } from "../../worker/browser/utils";

/**
 * IndexedDB-based implementation of ContractRepository.
 *
 * Data is stored as JSON strings in key/value stores.
 */
export class IndexedDBContractRepository implements ContractRepository {
    readonly version = 3 as const;
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
                keys.map((script) => promisifyRequest<ContractRow | undefined>(store.get(script))),
            );
            return pageResult(
                this.applyContractFilter(contracts.map(contractOf), normalized),
                page.limit,
                (contract) => contract.script,
            );
        }
        const watch = normalized.get("watch");
        const types = normalized.get("type");
        const after = page.after ?? "";
        // Each watch state, or (type, watch state) pair, is one run of its index in script order.
        const reads = watch
            ? [...new Set(watch)]
                  .flatMap((state) =>
                      types ? [...new Set(types)].map((type) => [type, state]) : [[state]],
                  )
                  .map((prefix) =>
                      this.readMatching(
                          store.index(types ? CONTRACT_TYPE_WATCH_INDEX : CONTRACT_WATCH_INDEX),
                          IDBKeyRange.bound(
                              [...prefix, after],
                              [...prefix, []],
                              page.after !== undefined,
                          ),
                          normalized,
                          page.limit,
                      ),
                  )
            : [
                  this.readMatching(
                      store,
                      page.after === undefined
                          ? undefined
                          : IDBKeyRange.lowerBound(page.after, true),
                      normalized,
                      page.limit,
                  ),
              ];
        const rows = (await Promise.all(reads))
            .flat()
            .sort((a, b) => (a.script < b.script ? -1 : a.script > b.script ? 1 : 0));
        return pageResult(rows, page.limit, (contract) => contract.script);
    }

    async saveContract(contract: Contract): Promise<void> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_CONTRACTS], "readwrite");
            transaction.objectStore(STORE_CONTRACTS).put(contractRow(contract));
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

    /** Up to `limit + 1` rows of `range` that pass `filter`, in key order. */
    private readMatching(
        source: IDBObjectStore | IDBIndex,
        range: IDBKeyRange | undefined,
        filter: ReturnType<typeof normalizeFilter>,
        limit: number,
    ): Promise<Contract[]> {
        const request = source.openCursor(range);
        return new Promise((resolve, reject) => {
            const rows: Contract[] = [];
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return resolve(rows);
                rows.push(...this.applyContractFilter([contractOf(cursor.value)], filter));
                if (rows.length > limit) return resolve(rows);
                cursor.continue();
            };
        });
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

const contractOf = (row: ContractRow | undefined): Contract | undefined => {
    if (!row) return undefined;
    const { watchState: _watchState, ...contract } = row;
    return contract;
};

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
