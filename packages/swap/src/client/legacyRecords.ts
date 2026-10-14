/**
 * Read-through over the stores a 0.0.x client wrote, so swaps in flight across the upgrade to 0.1
 * keep being driven and listed. v1 rows stay where they are.
 *
 * - **Corridor swaps** (`rfqSwaps`): adopted once as restored v2 records
 *   (`legacyRfqSwapsToAdopt`). Until then, or for a row adoption skipped, served to the manager
 *   beside the v2 records, and their state written back to `rfqSwaps`.
 * - **Offers** (`swaps`): every funded offer's deposit is taken back off the scan cursor until a
 *   v2 record adopts it, so the drive's deposit restore rebuilds it — settled ones included, so
 *   history survives the upgrade.
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

/**
 * v1 corridor rows, live or terminal, that no v2 record holds yet. A row whose `rfqId` is already
 * another v2 record's id is skipped: adoption keys on `rfqId` and must not overwrite that swap.
 */
export const legacyRfqSwapsToAdopt = async (
    repository: AssetSwapRepository,
): Promise<RfqSwapRecord[]> => {
    const v1 = await readLegacyRfqSwaps(repository);
    if (v1.length === 0) return [];
    const records = await collectSwapRecords(repository);
    const held = new Set(splitRecords(records).corridor.map((record) => record.rfqId));
    const ids = new Set(records.map((record) => record.id));
    return v1.filter((record) => {
        if (held.has(record.rfqId)) return false;
        if (ids.has(record.rfqId)) {
            console.warn(`[swap] v1 rfq swap ${record.rfqId} collides with a v2 record id`);
            return false;
        }
        return true;
    });
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

/**
 * Funding txids of funded v1 offers no v2 record has adopted yet, whatever their status: v1's
 * restore marked every deposit it read scanned, so without this a settled v1 offer would never
 * get a v2 record.
 */
export const legacyOfferDepositsToAdopt = async (
    repository: AssetSwapRepository,
): Promise<Set<string>> => {
    // Typed required, but onchain-HTLC rows carry no `offerHex` and an unfunded one no txid.
    const unadopted = (await readLegacyAssetSwaps(repository)).filter(
        (swap) => !!swap.offerHex && !!swap.fundingTxid,
    );
    if (unadopted.length === 0) return new Set();
    const { offer } = splitRecords(await collectSwapRecords(repository));
    const adopted = new Set(offer.map((record) => record.fundingTxid));
    return new Set(unadopted.map((swap) => swap.fundingTxid).filter((txid) => !adopted.has(txid)));
};
