import {
    applyCreatedAtOrder,
    applySwapsFilter,
    BoltzSwap,
    GetSwapsFilter,
    hasImpossibleSwapsFilter,
    SwapRepository,
} from "../swap-repository";
import {
    awaitTransaction,
    createManagedConnection,
    getAllByIndexValues,
    promisifyRequest,
    type ManagedConnection,
} from "@arkade-os/sdk";

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

function asArray<T>(v: T | T[] | undefined): T[] | undefined {
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v : [v];
}

export class IndexedDbSwapRepository implements SwapRepository {
    readonly version = 1 as const;
    private readonly connection: ManagedConnection;

    constructor(dbName: string = DEFAULT_DB_NAME) {
        this.connection = createManagedConnection(dbName, DB_VERSION, initDatabase);
    }

    private getDB(): Promise<IDBDatabase> {
        return this.connection.get();
    }

    async saveSwap<T extends BoltzSwap>(swap: T): Promise<void> {
        const db = await this.getDB();
        const transaction = db.transaction([STORE_SWAPS_STATE], "readwrite");
        transaction.objectStore(STORE_SWAPS_STATE).put(swap);
        await awaitTransaction(transaction);
    }

    async deleteSwap(id: string): Promise<void> {
        const db = await this.getDB();
        const transaction = db.transaction([STORE_SWAPS_STATE], "readwrite");
        transaction.objectStore(STORE_SWAPS_STATE).delete(id);
        await awaitTransaction(transaction);
    }

    async getAllSwaps<T extends BoltzSwap>(filter?: GetSwapsFilter): Promise<T[]> {
        return this.getAllSwapsFromStore<T>(filter);
    }

    async clear(): Promise<void> {
        const db = await this.getDB();
        const transaction = db.transaction([STORE_SWAPS_STATE], "readwrite");
        transaction.objectStore(STORE_SWAPS_STATE).clear();
        await awaitTransaction(transaction);
    }

    private async getAllSwapsFromStore<
        T extends {
            id: string;
            status: string;
            type: string;
            createdAt: number;
        },
    >(filter?: GetSwapsFilter): Promise<T[]> {
        if (hasImpossibleSwapsFilter(filter)) return [];

        const db = await this.getDB();
        const store = db
            .transaction([STORE_SWAPS_STATE], "readonly")
            .objectStore(STORE_SWAPS_STATE);

        if (!filter || Object.keys(filter).length === 0) {
            return (await promisifyRequest<T[]>(store.getAll())) ?? [];
        }

        const ids = asArray(filter.id);
        if (ids) {
            const swaps = await Promise.all(
                ids.map((id) => promisifyRequest<T | undefined>(store.get(id))),
            );
            return applyCreatedAtOrder(applySwapsFilter(swaps, filter) as T[], filter);
        }

        const types = asArray(filter.type);
        if (types) {
            const swaps = await getAllByIndexValues<T>(store, "type", types);
            return applyCreatedAtOrder(applySwapsFilter(swaps, filter) as T[], filter);
        }

        const statuses = asArray(filter.status);
        if (statuses) {
            const swaps = await getAllByIndexValues<T>(store, "status", statuses);
            return applyCreatedAtOrder(applySwapsFilter(swaps, filter) as T[], filter);
        }

        if (filter.orderBy === "createdAt") {
            return this.getAllSwapsByCreatedAt<T>(store, filter.orderDirection);
        }

        const allSwaps = (await promisifyRequest<T[]>(store.getAll())) ?? [];

        return applyCreatedAtOrder(applySwapsFilter(allSwaps, filter) as T[], filter);
    }

    private async getAllSwapsByCreatedAt<T>(
        store: IDBObjectStore,
        orderDirection?: GetSwapsFilter["orderDirection"],
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

    async [Symbol.asyncDispose](): Promise<void> {
        await this.connection[Symbol.asyncDispose]();
    }
}
