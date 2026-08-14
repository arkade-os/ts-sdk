import { closeDatabase, openDatabase } from "@arkade-os/sdk";
import { marketsCacheKey, type AssetSwapRepository, type MarketsCacheEntry } from "./repository";
import type { AssetSwap } from "./store";
import type { RfqSwapRecord } from "./rfqRecord";

const DEFAULT_DB_NAME = "arkade-intents";
/** Bump when adding an object store or index. `initDatabase` only runs inside
 * `onupgradeneeded`, which fires on a version *increase* — its contains-guard
 * cannot backfill a store into a database already open at this version, so a
 * new store added without a bump is simply missing for existing users. */
const DB_VERSION = 2;
const STORE_SWAPS = "swaps";
const STORE_RFQ_SWAPS = "rfqSwaps";
const STORE_SCANNED = "scannedTxids";
const STORE_MARKETS = "markets";

/** Every store, declared once. `clear()` wipes exactly this list, so a store
 * added here cannot be forgotten there — which would leave a partial wipe the
 * clear-all transaction exists to prevent. Key-only stores take no options:
 * the txid / cache key is supplied at put time. */
const STORES: readonly [name: string, options?: IDBObjectStoreParameters][] = [
    [STORE_SWAPS, { keyPath: "id" }],
    // v2. Separate from `swaps` rather than sharing it: the two record types
    // have different keys and no consumer wants them interleaved.
    [STORE_RFQ_SWAPS, { keyPath: "rfqId" }],
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

/** A write is durable at *commit*, not at request success — quota pressure and
 * storage eviction abort a transaction whose every request already succeeded.
 * Reads may resolve on the request; writes must await this. */
const txDone = (tx: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });

/** Browser backend over the SDK's shared IndexedDB manager — the same
 * infrastructure the wallet already uses for its Boltz swap repository. */
export class IndexedDbAssetSwapRepository implements AssetSwapRepository {
    readonly version = 3 as const;
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

    private async readStore(name: string): Promise<IDBObjectStore> {
        return (await this.ensureDb()).transaction([name], "readonly").objectStore(name);
    }

    /** Every write in one place, so none of them can forget to await the
     * commit. Requests need no individual await: a failed one aborts the
     * transaction, which `txDone` reports. */
    private async write(name: string, apply: (store: IDBObjectStore) => void): Promise<void> {
        const tx = (await this.ensureDb()).transaction([name], "readwrite");
        const done = txDone(tx);
        apply(tx.objectStore(name));
        await done;
    }

    async saveSwap(swap: AssetSwap): Promise<void> {
        await this.write(STORE_SWAPS, (store) => {
            store.put(swap);
        });
    }

    async getAllSwaps(): Promise<AssetSwap[]> {
        return request((await this.readStore(STORE_SWAPS)).getAll());
    }

    async saveRfqSwap(record: RfqSwapRecord): Promise<void> {
        await this.write(STORE_RFQ_SWAPS, (store) => {
            store.put(record);
        });
    }

    async getAllRfqSwaps(): Promise<RfqSwapRecord[]> {
        return request((await this.readStore(STORE_RFQ_SWAPS)).getAll());
    }

    async removeRfqSwap(rfqId: string): Promise<void> {
        await this.write(STORE_RFQ_SWAPS, (store) => {
            store.delete(rfqId);
        });
    }

    async getScannedTxids(): Promise<Set<string>> {
        const keys = await request((await this.readStore(STORE_SCANNED)).getAllKeys());
        return new Set(keys as string[]);
    }

    async markTxidsScanned(txids: Iterable<string>): Promise<void> {
        await this.write(STORE_SCANNED, (store) => {
            for (const txid of txids) store.put(txid, txid);
        });
    }

    async getCachedMarkets(
        network: string,
        registry: string,
    ): Promise<MarketsCacheEntry | undefined> {
        const store = await this.readStore(STORE_MARKETS);
        return request(store.get(marketsCacheKey(network, registry)));
    }

    async saveCachedMarkets(
        network: string,
        registry: string,
        entry: MarketsCacheEntry,
    ): Promise<void> {
        await this.write(STORE_MARKETS, (store) => {
            store.put(entry, marketsCacheKey(network, registry));
        });
    }

    /** All stores in one transaction: clearing swaps but keeping scanned txids
     * would leave the restore scan permanently skipping those funding txs, so
     * a partial clear must not be observable. */
    async clear(): Promise<void> {
        const stores = STORES.map(([name]) => name);
        const tx = (await this.ensureDb()).transaction(stores, "readwrite");
        const done = txDone(tx);
        for (const name of stores) tx.objectStore(name).clear();
        await done;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.dbPromise) return;
        await closeDatabase(this.dbName);
        this.dbPromise = null;
    }
}
