import { closeDatabase, openDatabase } from "@arkade-os/sdk";
import { marketsCacheKey, type AssetSwapRepository, type MarketsCacheEntry } from "./repository";
import type { AssetSwap } from "./store";

const DEFAULT_DB_NAME = "arkade-intents";
const DB_VERSION = 1;
const STORE_SWAPS = "swaps";
const STORE_SCANNED = "scannedTxids";
const STORE_MARKETS = "markets";

function initDatabase(db: IDBDatabase) {
    if (!db.objectStoreNames.contains(STORE_SWAPS)) {
        db.createObjectStore(STORE_SWAPS, { keyPath: "id" });
    }
    // key-only stores: the txid / cache key is supplied at put time
    if (!db.objectStoreNames.contains(STORE_SCANNED)) {
        db.createObjectStore(STORE_SCANNED);
    }
    if (!db.objectStoreNames.contains(STORE_MARKETS)) {
        db.createObjectStore(STORE_MARKETS);
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

    async getCachedMarkets(
        network: string,
        registry: string,
    ): Promise<MarketsCacheEntry | undefined> {
        const store = await this.store(STORE_MARKETS, "readonly");
        return request(store.get(marketsCacheKey(network, registry)));
    }

    async saveCachedMarkets(
        network: string,
        registry: string,
        entry: MarketsCacheEntry,
    ): Promise<void> {
        const store = await this.store(STORE_MARKETS, "readwrite");
        await request(store.put(entry, marketsCacheKey(network, registry)));
    }

    /** All stores in one transaction: clearing swaps but keeping scanned txids
     * would leave the restore scan permanently skipping those funding txs, so
     * a partial clear must not be observable. */
    async clear(): Promise<void> {
        const stores = [STORE_SWAPS, STORE_SCANNED, STORE_MARKETS];
        if (!this.db) this.db = await openDatabase(this.dbName, DB_VERSION, initDatabase);
        const tx = this.db.transaction(stores, "readwrite");
        const done = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        for (const name of stores) tx.objectStore(name).clear();
        await done;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.db) return;
        await closeDatabase(this.dbName);
        this.db = null;
    }
}
