import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import type { AssetSwap } from "./store";
import type { RfqSwapRecord } from "./rfqRecord";
import type { SwapRecord } from "./client/record";
import type { RfqSwapState } from "./rfqSwapState";

/** @deprecated Read swap history with `client.swaps()`. Moved off the package root to `@arkade-os/swap/protocol`. */
export const RFQ_SWAP_MAX_PAGE_SIZE = 500;

/** @deprecated Read swap history with `client.swaps()`. Moved off the package root to `@arkade-os/swap/protocol`. */
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

/** A cached registry discovery result. Refetchable, but must survive a cold boot:
 * serving it stale keeps quoting alive while a registry is down. */
export interface MarketsCacheEntry {
    markets: DiscoveredMarket[];
    fetchedAt: number;
}

/** Keyed by network AND registry so a redeployed registry override never
 * serves markets cached from a different registry. */
export const marketsCacheKey = (network: string, registry: string) =>
    `arkade-intents-markets-${network}-${registry}`;

/**
 * Everything the package persists: versioned interface, AsyncDisposable, one backend
 * per platform. Durable records and rebuildable state (scan cursor, markets cache) share
 * one store because they share a lifetime: one wallet on one device.
 *
 * ponytail: no query filters — every consumer reads all swaps and filters
 * in memory; add a filter type when a consumer needs subset queries.
 * RFQ history also has an optional state-scoped cursor read. Custom stores
 * without it keep the legacy all-record fallback.
 */
export interface AssetSwapRepository extends AsyncDisposable {
    /** Bumped on every shape change (5: v2 swap-record store) so an implementor built
     * against an older shape cannot satisfy this one silently. */
    readonly version: 5;

    /** Insert or replace a swap by id. Store the record whole: a field-mapped backend
     * dropping `preimageHex` or `preimageSaltHex` leaves the swap unclaimable.
     *
     * Records must be **JSON-safe**: SQLite and Realm serialize to JSON, so a `Date`
     * comes back a string, a `Set`/`Map` empty, and a `bigint` throws — unlike
     * IndexedDB's structured clone. Keep consumer-added fields JSON-safe. */
    saveSwap(swap: AssetSwap): Promise<void>;
    /** All stored swaps, in no particular order — `getAssetSwaps` is the
     * canonical newest-first read. */
    getAllSwaps(): Promise<AssetSwap[]>;

    /**
     * Insert or replace a monitored RFQ swap by `rfqId`.
     *
     * Store the record WHOLE: every field is a covenant parameter or manager state, and a
     * dropped one surfaces much later as a refund that cannot be signed.
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

    /**
     * Insert or replace a v2 swap record (what `accept()` writes) by its quote id.
     *
     * Separate from `swaps`: the v1 read path silently drops rows with neither `offerHex`
     * nor `paymentHash` as corrupt. v1 readers not seeing v2 rows is by design.
     *
     * Store the record WHOLE. Amounts are canonical decimal strings so every backend
     * agrees; a `bigint` would throw on SQLite/Realm and round-trip on IndexedDB.
     */
    saveSwapRecord(record: SwapRecord): Promise<void>;
    /** `undefined` on a miss — the ordinary answer for a first `accept()`, and what
     * makes it idempotent. */
    getSwapRecord(id: string): Promise<SwapRecord | undefined>;
    /** Every stored v2 record, in no particular order. */
    getAllSwapRecords(): Promise<SwapRecord[]>;
    /** Drop one, once it is past retention. */
    removeSwapRecord(id: string): Promise<void>;

    /**
     * Sent txids already checked for offer packets (see restore.ts). Deliberately shared
     * by both record families: they walk the same sent-txid set, and two cursors would
     * each re-walk what the other already answered.
     */
    getScannedTxids(): Promise<Set<string>>;
    markTxidsScanned(txids: Iterable<string>): Promise<void>;

    /** Cached registry markets, or undefined on a miss. Shared by both record families,
     * like the cursor, so one registry has one staleness clock. */
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
        // Dispose releases resources, not data: `await using` must mean the same
        // durability on every backend. Callers wanting deletion call clear().
    }
}
