/**
 * Read-through over the stores a 0.0.x client wrote, so swaps in flight across the upgrade to 0.1
 * keep being driven. Nothing is migrated: v1 rows stay where they are.
 *
 * - **Corridor swaps** (`rfqSwaps`): served to the manager beside the v2 records, and their state
 *   written back to `rfqSwaps`. Driven, never listed — they surface in no `Outcome` stream.
 * - **Offers** (`swaps`): a live offer's deposit is taken back off the scan cursor (v1's restore
 *   marks it answered), so the drive's deposit restore adopts it as a v2 record.
 *
 * Temporary. To remove: delete this file and the `LEGACY(v1)` sites in `drive.ts`.
 */
import { assertPageRequest } from "@arkade-os/sdk";
import {
    assertRfqSwapPageFilter,
    collectAssetSwaps,
    collectRfqSwaps,
    collectSwapRecords,
    type AssetSwapRepository,
    type RfqSwapPageFilter,
} from "../repository";
import type { AssetSwap } from "../store";
import type { RfqSwapRecord } from "../rfqRecord";
import { isRfqSwapTerminal } from "../rfqSwapState";
import { pageRfqRecords, splitRecords, type CorridorRecordStore } from "./driveRecords";

/** v1 corridor records, or none: an unreadable v1 store must not stop the v2 records. */
const readLegacyRfqSwaps = async (
    repository: AssetSwapRepository,
    filter: RfqSwapPageFilter = {},
): Promise<RfqSwapRecord[]> => {
    try {
        return await collectRfqSwaps(repository, filter);
    } catch (error) {
        console.warn("[swap] the v1 rfq swaps could not be read", error);
        return [];
    }
};

/** Live v1 corridor records: what the manager should take over. */
export const legacyLiveRfqSwaps = async (
    repository: AssetSwapRepository,
): Promise<RfqSwapRecord[]> =>
    (await readLegacyRfqSwaps(repository)).filter((record) => !isRfqSwapTerminal(record.state));

/**
 * `bridge` plus the v1 `rfqSwaps` rows `admits` lets through. On an `rfqId` in both, v2 wins.
 * `removeRfqSwap` stays inert for v1 rows too: retention is not this shim's call.
 */
export const withLegacyRfqSwaps = (
    bridge: CorridorRecordStore,
    repository: AssetSwapRepository,
    admits: (record: RfqSwapRecord) => boolean,
): CorridorRecordStore => {
    // Learned on read, so a write goes back to the store the record came from.
    const legacy = new Set<string>();

    return {
        index: bridge.index,
        quoteIdOf: bridge.quoteIdOf,

        async getRfqSwapsPage(filter, page) {
            assertPageRequest(page);
            assertRfqSwapPageFilter(filter);
            const v2 = await collectRfqSwaps(bridge, filter);
            // Every v2 rfqId, not just the admitted page: a terminal or differently-stated v2
            // copy must still shadow its v1 row.
            const held = new Set(
                splitRecords(await collectSwapRecords(repository)).corridor.map((r) => r.rfqId),
            );
            const v1 = (await readLegacyRfqSwaps(repository, filter)).filter(
                (record) => !held.has(record.rfqId) && admits(record),
            );
            for (const record of v1) legacy.add(record.rfqId);
            return pageRfqRecords([...v2, ...v1], filter, page);
        },

        async getRfqSwap(rfqId) {
            // Known v1 rows skip the bridge, whose miss costs a full v2 scan.
            if (!legacy.has(rfqId)) {
                const record = await bridge.getRfqSwap(rfqId);
                if (record !== undefined) return record;
            }
            const record = await repository.getRfqSwap(rfqId);
            if (record !== undefined) legacy.add(rfqId);
            return record;
        },

        async saveRfqSwap(record) {
            if (legacy.has(record.rfqId)) await repository.saveRfqSwap(record);
            else await bridge.saveRfqSwap(record);
        },

        removeRfqSwap: (rfqId) => bridge.removeRfqSwap(rfqId),
    };
};

/** v1 offers, or none: an unreadable v1 store must not stop the v2 deposit restore. */
const readLegacyAssetSwaps = async (repository: AssetSwapRepository): Promise<AssetSwap[]> => {
    try {
        return await collectAssetSwaps(repository);
    } catch (error) {
        console.warn("[swap] the v1 swaps could not be read", error);
        return [];
    }
};

/** Funding txids of live or swept v1 offers no v2 record has adopted yet. */
export const legacyOfferDepositsToReopen = async (
    repository: AssetSwapRepository,
): Promise<Set<string>> => {
    // Typed required, but onchain-HTLC rows carry no `offerHex` and an unfunded one no txid.
    const live = (await readLegacyAssetSwaps(repository)).filter(
        (swap) =>
            !!swap.offerHex &&
            !!swap.fundingTxid &&
            (swap.status === "pending" ||
                swap.status === "cancelling" ||
                swap.status === "recoverable"),
    );
    if (live.length === 0) return new Set();
    const { offer } = splitRecords(await collectSwapRecords(repository));
    const adopted = new Set(offer.map((record) => record.fundingTxid));
    return new Set(live.map((swap) => swap.fundingTxid).filter((txid) => !adopted.has(txid)));
};
