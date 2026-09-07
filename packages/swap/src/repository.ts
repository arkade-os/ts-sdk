import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import type { AssetSwap } from "./store";
import type { RfqSwapRecord } from "./rfqRecord";

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
 * convention (versioned interface, AsyncDisposable, one backend per
 * platform — see the Boltz plugin's SwapRepository). Consumers construct
 * exactly one of these; there is no second storage seam.
 *
 * Durable records (swaps) and rebuildable state (the restore scan's txid
 * cursor, the markets cache) live side by side because they share a
 * lifetime: all three belong to one wallet on one device, and a consumer
 * that wipes one wants all three gone.
 *
 * ponytail: no query filters — every consumer reads all swaps and filters
 * in memory; mirror the Boltz plugin's GetSwapsFilter when a consumer needs
 * subset queries.
 */
export interface AssetSwapRepository extends AsyncDisposable {
    /** 4 adds `getRfqSwap`. 3 added the other RFQ methods below; 2 was the
     * released shape — swaps, scan cursor, markets, with `preimageSaltHex` on
     * the swap record — so an implementor built against either cannot satisfy
     * this one silently. */
    readonly version: 4;

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

    /** Sent txids already checked for offer packets (see restore.ts). */
    getScannedTxids(): Promise<Set<string>>;
    markTxidsScanned(txids: Iterable<string>): Promise<void>;

    /** Cached registry markets, or undefined on a miss. */
    getCachedMarkets(network: string, registry: string): Promise<MarketsCacheEntry | undefined>;
    saveCachedMarkets(network: string, registry: string, entry: MarketsCacheEntry): Promise<void>;

    clear(): Promise<void>;
}

export class InMemoryAssetSwapRepository implements AssetSwapRepository {
    readonly version = 4 as const;
    private readonly swaps = new Map<string, AssetSwap>();
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
        this.scanned.clear();
        this.markets.clear();
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // dispose releases resources, it does not delete data — the IndexedDB
        // backend keeps its records too, and `await using` must not mean
        // different durability per backend. Callers wanting deletion call clear().
    }
}
