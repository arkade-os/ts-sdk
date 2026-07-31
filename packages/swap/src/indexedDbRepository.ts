import { closeDatabase, openDatabase } from "@arkade-os/sdk";
import type { AssetSwapRepository } from "./repository";
import type { AssetSwap } from "./store";

const DEFAULT_DB_NAME = "arkade-intents";
const DB_VERSION = 1;
const STORE_SWAPS = "swaps";
const STORE_SCANNED = "scannedTxids";

function initDatabase(db: IDBDatabase) {
    if (!db.objectStoreNames.contains(STORE_SWAPS)) {
        db.createObjectStore(STORE_SWAPS, { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains(STORE_SCANNED)) {
        // key-only store: the txid is both key and value
        db.createObjectStore(STORE_SCANNED);
    }
}

const request = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });

/** Browser backend over the SDK's shared IndexedDB manager — the same
 * infrastructure the wallet already uses for its Boltz swap repository. */
export class IndexedDbAssetSwapRepository implements AssetSwapRepository {
    readonly version = 1 as const;
    private db: IDBDatabase | null = null;

    constructor(private readonly dbName: string = DEFAULT_DB_NAME) {}

    private async store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
        if (!this.db) this.db = await openDatabase(this.dbName, DB_VERSION, initDatabase);
        return this.db.transaction([name], mode).objectStore(name);
    }

    async saveSwap(swap: AssetSwap): Promise<void> {
        await request((await this.store(STORE_SWAPS, "readwrite")).put(swap));
    }

    async getAllSwaps(): Promise<AssetSwap[]> {
        return request((await this.store(STORE_SWAPS, "readonly")).getAll());
    }

    async getScannedTxids(): Promise<Set<string>> {
        const keys = await request((await this.store(STORE_SCANNED, "readonly")).getAllKeys());
        return new Set(keys as string[]);
    }

    async markTxidsScanned(txids: Iterable<string>): Promise<void> {
        const store = await this.store(STORE_SCANNED, "readwrite");
        await Promise.all([...txids].map((txid) => request(store.put(txid, txid))));
    }

    async clear(): Promise<void> {
        await request((await this.store(STORE_SWAPS, "readwrite")).clear());
        await request((await this.store(STORE_SCANNED, "readwrite")).clear());
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.db) return;
        await closeDatabase(this.dbName);
        this.db = null;
    }
}
