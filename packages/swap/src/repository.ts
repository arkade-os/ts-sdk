import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import type { AssetSwap } from "./store";
import type { RfqSwapRecord } from "./rfqRecord";
import {
    advanceFundingSwap,
    canInsertPreparedSwap,
    mergeFundingProtectedSwap,
    type FundingStateAdvance,
} from "./fundingPersistence";
import type { RfqSwapState } from "./rfqSwapState";

export const RFQ_SWAP_MAX_PAGE_SIZE = 500;

export interface RfqHistoryCursor {
    updatedAt: number;
    rfqId: string;
}

export function assertRfqSwapPageLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > RFQ_SWAP_MAX_PAGE_SIZE) {
        throw new RangeError(
            `RFQ swap page limit must be an integer from 1 to ${RFQ_SWAP_MAX_PAGE_SIZE}`,
        );
    }
}

export function assertRfqSwapSince(since: number): void {
    if (!Number.isSafeInteger(since) || since < 0) {
        throw new RangeError("RFQ history since must be a non-negative Unix timestamp in seconds");
    }
}

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
 * RFQ history also has an optional state-scoped cursor read. Custom stores
 * without it keep the legacy all-record fallback.
 */
export interface AssetSwapRepository extends AsyncDisposable {
    /** 5 adds atomic prepared-funding persistence. */
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
    getSwap(id: string): Promise<AssetSwap | undefined>;
    insertPreparedSwap(swap: AssetSwap): Promise<boolean>;
    advanceFundingState(
        id: string,
        expected: "prepared" | "submitted",
        next: FundingStateAdvance,
    ): Promise<boolean>;
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
    /** One record by key. */
    getRfqSwap(rfqId: string): Promise<RfqSwapRecord | undefined>;
    /** Every stored RFQ swap record, in no particular order. Unbounded. */
    getAllRfqSwaps(): Promise<RfqSwapRecord[]>;
    /** Optional keyset page, ordered by rfqId within one state. `afterId` is exclusive; limit 1–500. */
    getRfqSwapsPage?(
        state: RfqSwapState,
        afterId: string | undefined,
        limit: number,
    ): Promise<RfqSwapRecord[]>;
    getRfqSwapsUpdatedPage?(
        state: RfqSwapState,
        since: number,
        after: RfqHistoryCursor | undefined,
        limit: number,
    ): Promise<RfqSwapRecord[]>;
    /** Drop one record. Only explicit pruning calls this; restore keeps history. */
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
    readonly version = 5 as const;
    private readonly swaps = new Map<string, AssetSwap>();
    private readonly rfqSwaps = new Map<string, RfqSwapRecord>();
    private readonly scanned = new Set<string>();
    private readonly markets = new Map<string, MarketsCacheEntry>();

    async saveSwap(swap: AssetSwap): Promise<void> {
        const merged = mergeFundingProtectedSwap(this.swaps.get(swap.id), swap);
        this.swaps.set(
            swap.id,
            merged.fundingIntent !== undefined ? structuredClone(merged) : merged,
        );
    }

    async getSwap(id: string): Promise<AssetSwap | undefined> {
        const swap = this.swaps.get(id);
        return swap ? structuredClone(swap) : undefined;
    }

    async insertPreparedSwap(swap: AssetSwap): Promise<boolean> {
        if (!canInsertPreparedSwap([...this.swaps.values()], swap)) return false;
        this.swaps.set(swap.id, structuredClone(swap));
        return true;
    }

    async advanceFundingState(
        id: string,
        expected: "prepared" | "submitted",
        next: FundingStateAdvance,
    ): Promise<boolean> {
        const result = advanceFundingSwap(this.swaps.get(id), expected, next);
        if (result.swap) this.swaps.set(id, structuredClone(result.swap));
        return result.ok;
    }

    async getAllSwaps(): Promise<AssetSwap[]> {
        return [...this.swaps.values()].map((swap) =>
            swap.fundingIntent !== undefined ? structuredClone(swap) : swap,
        );
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

    async getRfqSwapsPage(
        state: RfqSwapState,
        afterId: string | undefined,
        limit: number,
    ): Promise<RfqSwapRecord[]> {
        assertRfqSwapPageLimit(limit);
        return [...this.rfqSwaps.values()]
            .filter(
                (record) =>
                    record.state === state && (afterId === undefined || record.rfqId > afterId),
            )
            .sort((a, b) => (a.rfqId < b.rfqId ? -1 : a.rfqId > b.rfqId ? 1 : 0))
            .slice(0, limit);
    }

    async getRfqSwapsUpdatedPage(
        state: RfqSwapState,
        since: number,
        after: RfqHistoryCursor | undefined,
        limit: number,
    ): Promise<RfqSwapRecord[]> {
        assertRfqSwapPageLimit(limit);
        assertRfqSwapSince(since);
        return [...this.rfqSwaps.values()]
            .filter(
                (record) =>
                    record.state === state &&
                    record.updatedAt >= since &&
                    (!after ||
                        record.updatedAt > after.updatedAt ||
                        (record.updatedAt === after.updatedAt && record.rfqId > after.rfqId)),
            )
            .sort(
                (a, b) =>
                    a.updatedAt - b.updatedAt ||
                    (a.rfqId < b.rfqId ? -1 : a.rfqId > b.rfqId ? 1 : 0),
            )
            .slice(0, limit);
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
