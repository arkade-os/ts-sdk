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
 * Everything the package persists, following the monorepo repository
 * convention: versioned interface, AsyncDisposable, one backend per platform.
 * Consumers construct exactly one of these; there is no second storage seam.
 *
 * Durable records (swaps) and rebuildable state (the restore scan's txid
 * cursor, the markets cache) live side by side because they share a
 * lifetime: all three belong to one wallet on one device, and a consumer
 * that wipes one wants all three gone.
 *
 * Collection reads are paged. RFQ reads may filter by state and date.
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
    getAssetSwapsPage(page: PageRequest): Promise<PageResult<AssetSwap>>;

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
    getRfqSwapsPage(
        filter: RfqSwapPageFilter,
        page: PageRequest<RfqSwapPageCursor>,
    ): Promise<PageResult<RfqSwapRecord, RfqSwapPageCursor>>;
    /** Drop one record. Only explicit pruning calls this; restore keeps history. */
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
    getSwapRecordsPage(page: PageRequest): Promise<PageResult<SwapRecord>>;
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
        // dispose releases resources, it does not delete data — the IndexedDB
        // backend keeps its records too, and `await using` must not mean
        // different durability per backend. Callers wanting deletion call clear().
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
