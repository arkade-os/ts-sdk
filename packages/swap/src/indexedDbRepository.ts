import {
    awaitTransaction,
    createManagedConnection,
    promisifyRequest,
    type ManagedConnection,
} from "@arkade-os/sdk";
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

/**
 * @param oldVersion the version being upgraded FROM, 0 on a fresh install.
 * @param transaction the upgrade transaction — the only way to read or rewrite
 * existing rows during a migration.
 *
 * Both unused today: every version so far has only added an object store, and
 * `createObjectStore` needs neither. Named rather than dropped because the next
 * migration will not be additive, and a signature that takes them is what makes
 * "cursor over v2 rows and rewrite them" a local change here.
 */
function initDatabase(db: IDBDatabase, oldVersion: number, transaction: IDBTransaction | null) {
    void oldVersion;
    void transaction;
    for (const [name, options] of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
    }
}

/** Browser backend over the SDK's shared IndexedDB manager. */
export class IndexedDbAssetSwapRepository implements AssetSwapRepository {
    readonly version = 4 as const;
    private readonly connection: ManagedConnection;

    constructor(dbName: string = DEFAULT_DB_NAME) {
        this.connection = createManagedConnection(dbName, DB_VERSION, initDatabase);
    }

    private ensureDb(): Promise<IDBDatabase> {
        return this.connection.get();
    }

    private async readStore(name: string): Promise<IDBObjectStore> {
        return (await this.ensureDb()).transaction([name], "readonly").objectStore(name);
    }

    /** Every write in one place, so none of them can forget to await the
     * commit. Requests need no individual await: a failed one aborts the
     * transaction, which `awaitTransaction` reports. */
    private async write(name: string, apply: (store: IDBObjectStore) => void): Promise<void> {
        const tx = (await this.ensureDb()).transaction([name], "readwrite");
        const done = awaitTransaction(tx);
        apply(tx.objectStore(name));
        await done;
    }

    async saveSwap(swap: AssetSwap): Promise<void> {
        await this.write(STORE_SWAPS, (store) => {
            store.put(swap);
        });
    }

    async getAllSwaps(): Promise<AssetSwap[]> {
        return promisifyRequest((await this.readStore(STORE_SWAPS)).getAll());
    }

    async saveRfqSwap(record: RfqSwapRecord): Promise<void> {
        await this.write(STORE_RFQ_SWAPS, (store) => {
            store.put(record);
        });
    }

    async getRfqSwap(rfqId: string): Promise<RfqSwapRecord | undefined> {
        return promisifyRequest((await this.readStore(STORE_RFQ_SWAPS)).get(rfqId));
    }

    async getAllRfqSwaps(): Promise<RfqSwapRecord[]> {
        return promisifyRequest((await this.readStore(STORE_RFQ_SWAPS)).getAll());
    }

    async removeRfqSwap(rfqId: string): Promise<void> {
        await this.write(STORE_RFQ_SWAPS, (store) => {
            store.delete(rfqId);
        });
    }

    async getScannedTxids(): Promise<Set<string>> {
        const keys = await promisifyRequest((await this.readStore(STORE_SCANNED)).getAllKeys());
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
        return promisifyRequest(store.get(marketsCacheKey(network, registry)));
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
        const done = awaitTransaction(tx);
        for (const name of stores) tx.objectStore(name).clear();
        await done;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.connection[Symbol.asyncDispose]();
    }
}
