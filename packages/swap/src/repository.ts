import type { AssetSwap } from "./store";

/**
 * Persistence for asset-swap records, following the monorepo repository
 * convention (versioned interface, AsyncDisposable, one backend per
 * platform — see the Boltz plugin's SwapRepository). The restore scan's
 * incremental cursor (scanned txids) lives here too, so a backup that
 * captures the repository captures the scan state with it.
 *
 * ponytail: no query filters — every consumer reads all swaps and filters
 * in memory; mirror the Boltz plugin's GetSwapsFilter when a consumer needs
 * subset queries.
 */
export interface AssetSwapRepository extends AsyncDisposable {
    readonly version: 1;

    /** Insert or replace a swap by id. */
    saveSwap(swap: AssetSwap): Promise<void>;
    /** All stored swaps, in no particular order — `getAssetSwaps` is the
     * canonical newest-first read. */
    getAllSwaps(): Promise<AssetSwap[]>;

    /** Sent txids already checked for offer packets (see restore.ts). */
    getScannedTxids(): Promise<Set<string>>;
    markTxidsScanned(txids: Iterable<string>): Promise<void>;

    clear(): Promise<void>;
}

export class InMemoryAssetSwapRepository implements AssetSwapRepository {
    readonly version = 1 as const;
    private readonly swaps = new Map<string, AssetSwap>();
    private readonly scanned = new Set<string>();

    async saveSwap(swap: AssetSwap): Promise<void> {
        this.swaps.set(swap.id, swap);
    }

    async getAllSwaps(): Promise<AssetSwap[]> {
        return [...this.swaps.values()];
    }

    async getScannedTxids(): Promise<Set<string>> {
        return new Set(this.scanned);
    }

    async markTxidsScanned(txids: Iterable<string>): Promise<void> {
        for (const txid of txids) this.scanned.add(txid);
    }

    async clear(): Promise<void> {
        this.swaps.clear();
        this.scanned.clear();
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.clear();
    }
}
