import type { IWallet } from "@arkade-os/sdk";
import { restoreOfferCoverage } from "./offer";
import type { AssetSwapRepository } from "./repository";
import { restoreAssetSwaps, type RestoreIndexer, type Tx } from "./restore";
import { getAssetSwapsOrThrow, type AssetSwap } from "./store";

export interface AssetSwapRestoreChange {
    /** The stored record before this restore; absent for a rebuilt record. */
    previous?: AssetSwap;
    /** The record persisted by this restore. */
    current: AssetSwap;
}

export interface RestoreAssetSwapRepositoryOptions {
    wallet: IWallet;
    arkServerUrl: string;
    indexer: RestoreIndexer;
    repository: AssetSwapRepository;
    txs: Tx[];
    /** The server key the restored covenants were funded against, x-only. */
    serverPubkey: Uint8Array;
    /** Add consumer-owned metadata to a newly rebuilt record before it is saved. */
    prepareNew?: (swap: AssetSwap) => AssetSwap | Promise<AssetSwap>;
    /** Stops repository writes and coverage work after an in-flight scan returns. */
    signal?: AbortSignal;
}

export interface RestoreAssetSwapRepositoryResult {
    /** The repository's newest-first state after this operation. */
    swaps: AssetSwap[];
    /** Every record this operation inserted or updated. */
    changes: AssetSwapRestoreChange[];
    /** Funding txids newly added to the durable scan cursor. */
    scannedTxids: string[];
    /** Set when the caller cancelled before the operation could commit. */
    aborted: boolean;
    /** Coverage setup failed after records were safely persisted. Retry is safe. */
    coverageError?: unknown;
}

const isOpen = (swap: AssetSwap) => swap.status === "pending" || swap.status === "cancelling";

const aborted = (swaps: AssetSwap[]): RestoreAssetSwapRepositoryResult => ({
    swaps,
    changes: [],
    scannedTxids: [],
    aborted: true,
});

/**
 * Restore the durable asset-swap state for one wallet.
 *
 * This is the consumer entry point above the two lower-level recovery
 * primitives: it reads the repository, reopens every live record, persists
 * rebuilt records and outcomes before advancing the scan cursor, then restores
 * the wallet-contract coverage needed by the live watcher. Consumers keep only
 * presentation work (for example decorating a new record or announcing a
 * returned change).
 *
 * Scan and persistence failures reject. Coverage setup is different: records
 * are already safe by then, so its error is returned as `coverageError` and a
 * later call can retry without losing or duplicating anything.
 */
export async function restoreAssetSwapRepository(
    opts: RestoreAssetSwapRepositoryOptions,
): Promise<RestoreAssetSwapRepositoryResult> {
    const { wallet, arkServerUrl, indexer, repository, txs, serverPubkey, prepareNew, signal } =
        opts;
    const [existing, scanned] = await Promise.all([
        getAssetSwapsOrThrow(repository),
        repository.getScannedTxids(),
    ]);
    if (signal?.aborted) return aborted(existing);

    let scan: Awaited<ReturnType<typeof restoreAssetSwaps>>;
    try {
        scan = await restoreAssetSwaps(indexer, txs, new Set(existing.map((swap) => swap.id)), {
            serverPubkey,
            scanned,
            reopen: existing.filter(isOpen),
        });
    } catch (scanError) {
        // Coverage for records already on disk must not depend on the chain scan
        // succeeding. If both fail, preserve both causes for the caller.
        if (!signal?.aborted) {
            try {
                await restoreOfferCoverage(wallet, arkServerUrl, existing);
            } catch (coverageError) {
                throw new AggregateError(
                    [scanError, coverageError],
                    "asset-swap scan and covenant coverage restore both failed",
                );
            }
        }
        throw scanError;
    }
    if (signal?.aborted) return aborted(existing);

    const before = new Map(existing.map((swap) => [swap.id, swap]));
    const changes: AssetSwapRestoreChange[] = [];
    for (const restored of scan.restored) {
        if (signal?.aborted) return aborted(existing);
        const previous = before.get(restored.id);
        const current = previous || !prepareNew ? restored : await prepareNew(restored);
        if (current.id !== restored.id) {
            throw new Error("prepareNew must not change an asset swap id");
        }
        if (signal?.aborted) return aborted(existing);
        await repository.saveSwap(current);
        changes.push(previous ? { previous, current } : { current });
    }

    if (signal?.aborted) return aborted(existing);
    if (scan.scannedTxids.length > 0) {
        await repository.markTxidsScanned(scan.scannedTxids);
    }
    const swaps = await getAssetSwapsOrThrow(repository);
    if (signal?.aborted) return aborted(swaps);

    let coverageError: unknown;
    try {
        await restoreOfferCoverage(wallet, arkServerUrl, swaps);
    } catch (error) {
        coverageError = error;
    }
    return {
        swaps,
        changes,
        scannedTxids: scan.scannedTxids,
        aborted: false,
        ...(coverageError === undefined ? {} : { coverageError }),
    };
}
