import {
    GetSwapsFilter,
    PendingSwap,
    SwapRepository,
} from "../swap-repository";
import { closeDatabase, openDatabase } from "@arkade-os/sdk";

const DEFAULT_DB_NAME = "arkade-boltz-swap";
const DB_VERSION = 2;
const STORE_SWAPS_STATE = "swaps";

function initDatabase(db: IDBDatabase) {
    if (!db.objectStoreNames.contains(STORE_SWAPS_STATE)) {
        const swapStore = db.createObjectStore(STORE_SWAPS_STATE, {
            keyPath: "id",
        });
        swapStore.createIndex("status", "status", { unique: false });
        swapStore.createIndex("type", "type", { unique: false });
        swapStore.createIndex("createdAt", "createdAt", { unique: false });
    }
}

export class IndexedDbSwapRepository implements SwapRepository {
    readonly version = 1 as const;
    private db: IDBDatabase | null = null;

    constructor(private readonly dbName: string = DEFAULT_DB_NAME) {}

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;
        this.db = await openDatabase(this.dbName, DB_VERSION, initDatabase);
        return this.db;
    }

    async saveSwap<T extends PendingSwap>(swap: T): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [STORE_SWAPS_STATE],
                "readwrite"
            );
            const store = transaction.objectStore(STORE_SWAPS_STATE);
            const request = store.put(swap);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async deleteSwap(id: string): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [STORE_SWAPS_STATE],
                "readwrite"
            );
            const store = transaction.objectStore(STORE_SWAPS_STATE);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getAllSwaps<T extends PendingSwap>(
        filter?: GetSwapsFilter
    ): Promise<T[]> {
        return this.getAllSwapsFromStore<T>(filter);
    }

    async clear(): Promise<void> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(
                [STORE_SWAPS_STATE],
                "readwrite"
            );
            const store = transaction.objectStore(STORE_SWAPS_STATE);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    private getSwapsByIndexValues<T>(
        store: IDBObjectStore,
        indexName: string,
        values: string[]
    ): Promise<T[]> {
        if (values.length === 0) return Promise.resolve([]);
        const index = store.index(indexName);
        const requests = values.map(
            (value) =>
                new Promise<T[]>((resolve, reject) => {
                    const request = index.getAll(value);
                    request.onerror = () => reject(request.error);
                    request.onsuccess = () => resolve(request.result ?? []);
                })
        );
        return Promise.all(requests).then((results) =>
            results.flatMap((result) => result)
        );
    }

    private async getAllSwapsFromStore<
        T extends {
            id: string;
            status: string;
            type: string;
            createdAt: number;
        },
    >(filter?: GetSwapsFilter): Promise<T[]> {
        const db = await this.getDB();
        const store = db
            .transaction([STORE_SWAPS_STATE], "readonly")
            .objectStore(STORE_SWAPS_STATE);

        if (!filter || Object.keys(filter).length === 0) {
            return new Promise((resolve, reject) => {
                const request = store.getAll();
                request.onsuccess = () =>
                    resolve((request.result ?? []) as T[]);
                request.onerror = () => reject(request.error);
            });
        }

        const normalizedFilter = normalizeFilter(filter);

        if (normalizedFilter.has("id")) {
            const ids = normalizedFilter.get("id")!;
            const swaps = await Promise.all(
                ids.map(
                    (id) =>
                        new Promise<T | undefined>((resolve, reject) => {
                            const request = store.get(id);
                            request.onsuccess = () =>
                                resolve(request.result as T | undefined);
                            request.onerror = () => reject(request.error);
                        })
                )
            );
            return this.sortIfNeeded(
                this.applySwapsFilter(swaps, normalizedFilter),
                filter
            );
        }

        if (normalizedFilter.has("type")) {
            const types = normalizedFilter.get("type")!;
            const swaps = await this.getSwapsByIndexValues<T>(
                store,
                "type",
                types
            );
            return this.sortIfNeeded(
                this.applySwapsFilter(swaps, normalizedFilter),
                filter
            );
        }

        if (normalizedFilter.has("status")) {
            const ids = normalizedFilter.get("status")!;
            const swaps = await this.getSwapsByIndexValues<T>(
                store,
                "status",
                ids
            );
            return this.sortIfNeeded(
                this.applySwapsFilter(swaps, normalizedFilter),
                filter
            );
        }

        if (filter.orderBy === "createdAt") {
            return this.getAllSwapsByCreatedAt<T>(store, filter.orderDirection);
        }

        const allSwaps = await new Promise<T[]>((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result ?? []);
            request.onerror = () => reject(request.error);
        });

        return this.sortIfNeeded(
            this.applySwapsFilter(allSwaps, normalizedFilter),
            filter
        );
    }

    private applySwapsFilter<
        T extends { id: string; status: string; type: string },
    >(
        swaps: (T | undefined)[],
        filter: ReturnType<typeof normalizeFilter>
    ): T[] {
        return swaps.filter((swap): swap is T => {
            if (swap === undefined) return false;
            if (filter.has("id") && !filter.get("id")?.includes(swap.id))
                return false;
            if (
                filter.has("status") &&
                !filter.get("status")?.includes(swap.status)
            )
                return false;
            if (filter.has("type") && !filter.get("type")?.includes(swap.type))
                return false;
            return true;
        });
    }

    private async getAllSwapsByCreatedAt<T>(
        store: IDBObjectStore,
        orderDirection?: GetSwapsFilter["orderDirection"]
    ): Promise<T[]> {
        const index = store.index("createdAt");
        const direction = orderDirection === "desc" ? "prev" : "next";
        return new Promise((resolve, reject) => {
            const results: T[] = [];
            const request = index.openCursor(null, direction);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(results);
                    return;
                }
                results.push(cursor.value as T);
                cursor.continue();
            };
        });
    }

    private sortIfNeeded<T extends { createdAt: number }>(
        swaps: T[],
        filter?: GetSwapsFilter
    ): T[] {
        if (filter?.orderBy !== "createdAt") return swaps;
        const direction = filter.orderDirection === "asc" ? 1 : -1;
        return swaps
            .slice()
            .sort((a, b) => (a.createdAt - b.createdAt) * direction);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.db) return;
        await closeDatabase(this.dbName);
        this.db = null;
    }
}

const FILTER_FIELDS = ["id", "status", "type"] as (keyof GetSwapsFilter)[];

// Transform all filter fields into an array of values
function normalizeFilter(filter: GetSwapsFilter) {
    const res = new Map<keyof GetSwapsFilter, string[]>();
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
