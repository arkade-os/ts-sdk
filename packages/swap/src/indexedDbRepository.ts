import { closeDatabase, openDatabase } from "@arkade-os/sdk";
import { marketsCacheKey, type AssetSwapRepository, type MarketsCacheEntry } from "./repository";
import type { AssetSwap } from "./store";

const DEFAULT_DB_NAME = "arkade-intents";
/** Bump when adding an object store or index. `initDatabase` only runs inside
 * `onupgradeneeded`, which fires on a version *increase* — its contains-guard
 * cannot backfill a store into a database already open at this version, so a
 * new store added without a bump is simply missing for existing users. */
const DB_VERSION = 1;
const STORE_SWAPS = "swaps";
const STORE_SCANNED = "scannedTxids";
const STORE_MARKETS = "markets";

/** Every store, declared once. `clear()` wipes exactly this list, so a store
 * added here cannot be forgotten there — which would leave a partial wipe the
 * clear-all transaction exists to prevent. Key-only stores take no options:
 * the txid / cache key is supplied at put time. */
const STORES: readonly [name: string, options?: IDBObjectStoreParameters][] = [
    [STORE_SWAPS, { keyPath: "id" }],
    [STORE_SCANNED],
    [STORE_MARKETS],
];

function initDatabase(db: IDBDatabase) {
    for (const [name, options] of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
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
    // the promise, not the resolved database: openDatabase bumps a refcount on
    // every call including cache hits, while dispose closes once, so two
    // concurrent first calls would strand the refcount above zero and leak the
    // connection for the process lifetime. Cleared on failure so a failed open
    // can be retried rather than cached forever.
    private dbPromise: Promise<IDBDatabase> | null = null;

    constructor(private readonly dbName: string = DEFAULT_DB_NAME) {}

    private ensureDb(): Promise<IDBDatabase> {
        return (this.dbPromise ??= openDatabase(this.dbName, DB_VERSION, initDatabase).catch(
            (err) => {
                this.dbPromise = null;
                throw err;
            },
        ));
    }

    private async store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
        return (await this.ensureDb()).transaction([name], mode).objectStore(name);
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
        const stores = STORES.map(([name]) => name);
        const tx = (await this.ensureDb()).transaction(stores, "readwrite");
        const done = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        for (const name of stores) tx.objectStore(name).clear();
        await done;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.dbPromise) return;
        await closeDatabase(this.dbName);
        this.dbPromise = null;
    }
}
