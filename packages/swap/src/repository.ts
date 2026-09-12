import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import type { AssetSwap } from "./store";
import type { RfqSwapRecord } from "./rfqRecord";
import type { SwapRecord } from "./client/record";

/** A registry discovery result held for reuse. Refetchable — unlike a swap
 * record, losing it costs one network round trip — but it must survive a cold
 * boot: serving it stale is what keeps quoting alive while a registry is down. */
export interface MarketsCacheEntry {
    markets: DiscoveredMarket[];
    fetchedAt: number;
}

/** Keyed by network AND registry so a redeployed registry override never
 * serves markets cached from a different registry. */
export const marketsCacheKey = (network: string, registry: string) =>
    `arkade-intents-markets-${network}-${registry}`;

/**
 * Everything the package persists, following the monorepo repository
 * convention: versioned interface, AsyncDisposable, one backend per platform.
 * Consumers construct exactly one of these; there is no second storage seam.
 *
 * Durable records (swaps) and rebuildable state (the restore scan's txid
 * cursor, the markets cache) live side by side because they share a
 * lifetime: all three belong to one wallet on one device, and a consumer
 * that wipes one wants all three gone.
 *
 * ponytail: no query filters — every consumer reads all swaps and filters
 * in memory; add a filter type when a consumer needs subset queries.
 */
export interface AssetSwapRepository extends AsyncDisposable {
    /** 5 adds the v2 swap-record store — one row per accepted swap, keyed by
     * the client-minted quote id. 4 added `getRfqSwap`; 3 added the other RFQ
     * methods below; 2 was the released shape — swaps, scan cursor, markets,
     * with `preimageSaltHex` on the swap record — so an implementor built
     * against any of them cannot satisfy this one silently. */
    readonly version: 5;

    /** Insert or replace a swap by id. Store the record whole: `preimageHex`
     * and `preimageSaltHex` both leave the swap unclaimable if a field-mapped
     * backend drops them — the first is the only claim secret of a swap whose
     * signer cannot derive, the second the public input every other static
     * wallet's preimage derives from.
     *
     * Records must be **JSON-safe**: the SQLite and Realm backends serialize
     * the record to JSON, so a `Date` in a consumer-added field comes back a
     * string, a `Set`/`Map` comes back empty, and a `bigint` throws here —
     * none of which happens on IndexedDB's structured clone. `AssetSwap` as
     * declared is JSON-safe; keep added fields that way. */
    saveSwap(swap: AssetSwap): Promise<void>;
    /** All stored swaps, in no particular order — `getAssetSwaps` is the
     * canonical newest-first read. */
    getAllSwaps(): Promise<AssetSwap[]>;

    /**
     * Insert or replace a monitored RFQ swap by `rfqId`.
     *
     * Store the record WHOLE. Every field is a covenant tree parameter or the
     * manager's own state, and a field-mapped backend that drops one round-trips
     * a record whose covenant `rebuildRfqSwap` cannot reproduce — which surfaces
     * as a refund that cannot be signed, long after the write.
     */
    saveRfqSwap(record: RfqSwapRecord): Promise<void>;
    /** One record by key. `undefined` on a miss — retention prunes terminal
     * records, so absence is ordinary and not an error. */
    getRfqSwap(rfqId: string): Promise<RfqSwapRecord | undefined>;
    /** Every stored RFQ swap record, in no particular order. */
    getAllRfqSwaps(): Promise<RfqSwapRecord[]>;
    /** Drop one, once it is past retention — see `shouldRetainRfqSwap`. */
    removeRfqSwap(rfqId: string): Promise<void>;

    /**
     * Insert or replace a v2 swap record by its quote id.
     *
     * The store the v2 client's `accept()` writes, and the reason this
     * interface is at 5. Separate from `swaps` rather than sharing it: the v1
     * read path drops any row carrying neither `offerHex` nor `paymentHash`
     * (`getAssetSwapsOrThrow`), silently and as corrupt, so a v2 record in that
     * store would be pinned by a v1 predicate — and the two histories are meant
     * to be disjoint for the deprecation window anyway. A v1 reader not seeing
     * v2 rows is the design, asserted in the conformance suite rather than
     * tolerated.
     *
     * Store the record WHOLE, and note that it is **JSON-safe by declaration**:
     * every amount on it is a canonical decimal string, precisely so the SQLite
     * and Realm backends' `JSON.stringify` and IndexedDB's structured clone
     * agree. A `bigint` reaching here would throw on two backends and
     * round-trip on the third.
     */
    saveSwapRecord(record: SwapRecord): Promise<void>;
    /** One record by quote id. `undefined` on a miss — which is the ordinary
     * answer for a first `accept()`, and what makes it idempotent. */
    getSwapRecord(id: string): Promise<SwapRecord | undefined>;
    /** Every stored v2 record, in no particular order. */
    getAllSwapRecords(): Promise<SwapRecord[]>;
    /** Drop one, once it is past retention. */
    removeSwapRecord(id: string): Promise<void>;

    /**
     * Sent txids already checked for offer packets (see restore.ts).
     *
     * **Shared across both record families, deliberately.** This is not
     * record-family data — it marks txids of transactions a scan has answered,
     * whatever family a later record belongs to — and both families walk the
     * same sent-txid set during the deprecation window. Two cursors would have
     * each side re-walking deposits the other already answered.
     */
    getScannedTxids(): Promise<Set<string>>;
    markTxidsScanned(txids: Iterable<string>): Promise<void>;

    /** Cached registry markets, or undefined on a miss. Shared across both
     * record families for the reason the cursor is: the key is network-and-
     * registry, not a store, and two caches would serve two staleness clocks
     * for one registry. */
    getCachedMarkets(network: string, registry: string): Promise<MarketsCacheEntry | undefined>;
    saveCachedMarkets(network: string, registry: string, entry: MarketsCacheEntry): Promise<void>;

    clear(): Promise<void>;
}

export class InMemoryAssetSwapRepository implements AssetSwapRepository {
    readonly version = 5 as const;
    private readonly swaps = new Map<string, AssetSwap>();
    private readonly records = new Map<string, SwapRecord>();
    private readonly rfqSwaps = new Map<string, RfqSwapRecord>();
    private readonly scanned = new Set<string>();
    private readonly markets = new Map<string, MarketsCacheEntry>();

    async saveSwap(swap: AssetSwap): Promise<void> {
        this.swaps.set(swap.id, swap);
    }

    async getAllSwaps(): Promise<AssetSwap[]> {
        return [...this.swaps.values()];
    }

    async saveRfqSwap(record: RfqSwapRecord): Promise<void> {
        this.rfqSwaps.set(record.rfqId, record);
    }

    async getRfqSwap(rfqId: string): Promise<RfqSwapRecord | undefined> {
        return this.rfqSwaps.get(rfqId);
    }

    async getAllRfqSwaps(): Promise<RfqSwapRecord[]> {
        return [...this.rfqSwaps.values()];
    }

    async removeRfqSwap(rfqId: string): Promise<void> {
        this.rfqSwaps.delete(rfqId);
    }

    async saveSwapRecord(record: SwapRecord): Promise<void> {
        this.records.set(record.id, record);
    }

    async getSwapRecord(id: string): Promise<SwapRecord | undefined> {
        return this.records.get(id);
    }

    async getAllSwapRecords(): Promise<SwapRecord[]> {
        return [...this.records.values()];
    }

    async removeSwapRecord(id: string): Promise<void> {
        this.records.delete(id);
    }

    async getScannedTxids(): Promise<Set<string>> {
        return new Set(this.scanned);
    }

    async markTxidsScanned(txids: Iterable<string>): Promise<void> {
        for (const txid of txids) this.scanned.add(txid);
    }

    async getCachedMarkets(
        network: string,
        registry: string,
    ): Promise<MarketsCacheEntry | undefined> {
        return this.markets.get(marketsCacheKey(network, registry));
    }

    async saveCachedMarkets(
        network: string,
        registry: string,
        entry: MarketsCacheEntry,
    ): Promise<void> {
        this.markets.set(marketsCacheKey(network, registry), entry);
    }

    async clear(): Promise<void> {
        this.swaps.clear();
        this.rfqSwaps.clear();
        this.records.clear();
        this.scanned.clear();
        this.markets.clear();
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // dispose releases resources, it does not delete data — the IndexedDB
        // backend keeps its records too, and `await using` must not mean
        // different durability per backend. Callers wanting deletion call clear().
    }
}
