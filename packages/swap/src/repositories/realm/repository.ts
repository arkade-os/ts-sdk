import type { RealmLike } from "@arkade-os/sdk/repositories/realm";
import {
    marketsCacheKey,
    type AssetSwapRepository,
    type MarketsCacheEntry,
} from "../../repository";
import type { AssetSwap } from "../../store";
import type { RfqSwapRecord } from "../../rfqRecord";

const SWAPS = "ArkadeAssetSwap";
const RFQ_SWAPS = "ArkadeRfqSwap";
const SCANNED = "ArkadeAssetSwapScannedTxid";
const MARKETS = "ArkadeAssetSwapMarketsCache";

/**
 * Realm backend for React Native.
 *
 * `realm` is not a dependency of this package: consumers open Realm with the
 * schemas from `./schemas.ts` and pass the instance, validated against the
 * shared `RealmLike` shape from `@arkade-os/sdk`.
 *
 * **Records are serialized as JSON**, whole, into a `data` property —
 * `status` and `createdAt` are mapped out for querying only, so no field of a
 * record can be dropped. That holds for JSON-safe values: a consumer-added
 * `Date` comes back a string and a `bigint` throws on save, unlike the
 * IndexedDB backend's structured clone. `AssetSwap` itself is JSON-safe by
 * design, and so is `RfqSwapRecord` — including its corridor `profile`, which is
 * plain JSON by the handler contract (see `rfqCorridor.ts`). Whole-record
 * storage is what keeps a nested `profile.hashlock` from being lost the way a
 * field-mapped backend could lose it.
 *
 * Realm creates the schemas on open, so there is nothing to initialise. The
 * consumer owns the Realm lifecycle — `[Symbol.asyncDispose]` is a no-op.
 */
export class RealmAssetSwapRepository implements AssetSwapRepository {
    readonly version = 3 as const;

    constructor(private readonly realm: RealmLike) {}

    async saveSwap(swap: AssetSwap): Promise<void> {
        this.realm.write(() => {
            this.realm.create(
                SWAPS,
                {
                    id: swap.id,
                    status: swap.status,
                    createdAt: swap.createdAt,
                    data: JSON.stringify(swap),
                },
                "modified",
            );
        });
    }

    async getAllSwaps(): Promise<AssetSwap[]> {
        return [...this.realm.objects<{ data: string }>(SWAPS)].map(
            (o) => JSON.parse(o.data) as AssetSwap,
        );
    }

    async saveRfqSwap(record: RfqSwapRecord): Promise<void> {
        this.realm.write(() => {
            this.realm.create(
                RFQ_SWAPS,
                {
                    rfqId: record.rfqId,
                    state: record.state,
                    updatedAt: record.updatedAt,
                    data: JSON.stringify(record),
                },
                "modified",
            );
        });
    }

    async getAllRfqSwaps(): Promise<RfqSwapRecord[]> {
        return [...this.realm.objects<{ data: string }>(RFQ_SWAPS)].map(
            (o) => JSON.parse(o.data) as RfqSwapRecord,
        );
    }

    async removeRfqSwap(rfqId: string): Promise<void> {
        this.realm.write(() => {
            this.realm.delete(
                this.realm.objects<{ rfqId: string }>(RFQ_SWAPS).filtered("rfqId == $0", rfqId),
            );
        });
    }

    async getScannedTxids(): Promise<Set<string>> {
        return new Set([...this.realm.objects<{ txid: string }>(SCANNED)].map((o) => o.txid));
    }

    async markTxidsScanned(txids: Iterable<string>): Promise<void> {
        this.realm.write(() => {
            for (const txid of txids) this.realm.create(SCANNED, { txid }, "modified");
        });
    }

    async getCachedMarkets(
        network: string,
        registry: string,
    ): Promise<MarketsCacheEntry | undefined> {
        const [row] = [
            ...this.realm
                .objects<{ data: string }>(MARKETS)
                .filtered("key == $0", marketsCacheKey(network, registry)),
        ];
        return row ? (JSON.parse(row.data) as MarketsCacheEntry) : undefined;
    }

    async saveCachedMarkets(
        network: string,
        registry: string,
        entry: MarketsCacheEntry,
    ): Promise<void> {
        this.realm.write(() => {
            this.realm.create(
                MARKETS,
                { key: marketsCacheKey(network, registry), data: JSON.stringify(entry) },
                "modified",
            );
        });
    }

    /** Every schema in one write: clearing swaps but keeping scanned txids would
     * leave the restore scan permanently skipping those funding txs, so a
     * partial clear must not be observable. */
    async clear(): Promise<void> {
        this.realm.write(() => {
            for (const name of [SWAPS, RFQ_SWAPS, SCANNED, MARKETS]) {
                this.realm.delete(this.realm.objects(name));
            }
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // no-op — the consumer owns the Realm lifecycle
    }
}
