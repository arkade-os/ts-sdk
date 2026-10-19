import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import {
    assertPageRequest,
    collectPages,
    pageResult,
    type PageRequest,
    type PageResult,
} from "@arkade-os/sdk";
import type { AssetSwap } from "./store";
import type { RfqSwapRecord } from "./rfqRecord";
import type { RfqSwapState } from "./rfqSwapState";
import type { SwapRecord } from "./client/record";

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

export interface RfqSwapPageFilter {
    state?: RfqSwapState;
    /** Inclusive Unix seconds. */
    since?: number;
}

export interface RfqSwapPageCursor {
    updatedAt: number;
    rfqId: string;
}

export function assertRfqSwapPageFilter(filter: RfqSwapPageFilter): void {
    if (filter.since !== undefined && (!Number.isSafeInteger(filter.since) || filter.since < 0)) {
        throw new RangeError("RFQ history since must be non-negative Unix seconds");
    }
}

/**
 * Everything the package persists: versioned interface, AsyncDisposable, one backend
 * per platform. Durable records and rebuildable state (scan cursor, markets cache) share
 * one store because they share a lifetime: one wallet on one device.
 *
 * Collection reads are paged. RFQ reads may filter by state and date.
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
    getAssetSwapsPage(page: PageRequest): Promise<PageResult<AssetSwap>>;

    /**
     * Insert or replace a monitored RFQ swap by `rfqId`.
     *
     * Store the record WHOLE: every field is a covenant parameter or manager state, and a
     * dropped one surfaces much later as a refund that cannot be signed.
     */
    saveRfqSwap(record: RfqSwapRecord): Promise<void>;
    /** One record by key. */
    getRfqSwap(rfqId: string): Promise<RfqSwapRecord | undefined>;
    getRfqSwapsPage(
        filter: RfqSwapPageFilter,
        page: PageRequest<RfqSwapPageCursor>,
    ): Promise<PageResult<RfqSwapRecord, RfqSwapPageCursor>>;
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
    getSwapRecordsPage(page: PageRequest): Promise<PageResult<SwapRecord>>;
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

    async getAssetSwapsPage(page: PageRequest): Promise<PageResult<AssetSwap>> {
        return pageMap(this.swaps, page);
    }

    async saveRfqSwap(record: RfqSwapRecord): Promise<void> {
        this.rfqSwaps.set(record.rfqId, record);
    }

    async getRfqSwap(rfqId: string): Promise<RfqSwapRecord | undefined> {
        return this.rfqSwaps.get(rfqId);
    }

    async getRfqSwapsPage(
        filter: RfqSwapPageFilter,
        page: PageRequest<RfqSwapPageCursor>,
    ): Promise<PageResult<RfqSwapRecord, RfqSwapPageCursor>> {
        assertPageRequest(page);
        assertRfqSwapPageFilter(filter);
        const rows = [...this.rfqSwaps.values()]
            .filter(
                (record) =>
                    (filter.state === undefined || record.state === filter.state) &&
                    (filter.since === undefined || record.updatedAt >= filter.since) &&
                    (!page.after ||
                        record.updatedAt > page.after.updatedAt ||
                        (record.updatedAt === page.after.updatedAt &&
                            record.rfqId > page.after.rfqId)),
            )
            .sort(
                (a, b) =>
                    a.updatedAt - b.updatedAt ||
                    (a.rfqId < b.rfqId ? -1 : a.rfqId > b.rfqId ? 1 : 0),
            )
            .slice(0, page.limit + 1);
        return pageResult(rows, page.limit, (record) => ({
            updatedAt: record.updatedAt,
            rfqId: record.rfqId,
        }));
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

    async getSwapRecordsPage(page: PageRequest): Promise<PageResult<SwapRecord>> {
        return pageMap(this.records, page);
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

function pageMap<Item>(records: Map<string, Item>, page: PageRequest): PageResult<Item> {
    assertPageRequest(page);
    const rows = [...records]
        .filter(([id]) => page.after === undefined || id > page.after)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, page.limit + 1);
    const result = pageResult(rows, page.limit, ([id]) => id);
    return {
        items: result.items.map(([, item]) => item),
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
    };
}

export const collectAssetSwaps = (repository: Pick<AssetSwapRepository, "getAssetSwapsPage">) =>
    collectPages((page: PageRequest<string>) => repository.getAssetSwapsPage(page));

export const collectRfqSwaps = (
    repository: Pick<AssetSwapRepository, "getRfqSwapsPage">,
    filter: RfqSwapPageFilter = {},
) =>
    collectPages((page: PageRequest<RfqSwapPageCursor>) =>
        repository.getRfqSwapsPage(filter, page),
    );

export const collectSwapRecords = (repository: Pick<AssetSwapRepository, "getSwapRecordsPage">) =>
    collectPages((page: PageRequest<string>) => repository.getSwapRecordsPage(page));
