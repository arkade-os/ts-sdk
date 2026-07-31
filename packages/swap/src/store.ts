import type { AssetSwapRepository } from "./repository";

export type AssetSwapStatus = "pending" | "cancelling" | "fulfilled" | "cancelled" | "recoverable";

// ponytail: records carry only chain-recoverable facts — no quote-time display
// snapshot (tickers, fee bps, fiat value); add an optional snapshot field back
// if a consumer must persist display metadata the restore scan cannot rebuild

export interface AssetSwap {
    /** Funding txid — the swap's identity. */
    id: string;
    /** 'btc' or a 68-hex asset id. */
    fromAsset: string;
    toAsset: string;
    /** Atomic amounts as strings (bigint is not JSON-safe). */
    fromAmount: string;
    /** The covenant wantAmount — a floor, the fill pays >= this. */
    toAmount: string;
    swapAddress: string;
    /** Hex pkScript of the swap contract — the indexer monitoring key. */
    swapPkScript: string;
    /** TLV offer — needed to rebuild the contract for cancel. */
    offerHex: string;
    fundingTxid: string;
    spentTxid?: string;
    status: AssetSwapStatus;
    createdAt: number;
    completedAt?: number;
}

/** All swaps, newest-first. Insertion order is not chronological — the restore
 * scan rebuilds records in tx-scan order — so sort at read to keep
 * newest-first canonical for every consumer. A broken backend reads as no
 * swaps rather than crashing the caller. */
export const getAssetSwaps = async (repository: AssetSwapRepository): Promise<AssetSwap[]> => {
    try {
        return (await repository.getAllSwaps())
            .filter((s) => s && typeof s.id === "string" && typeof s.offerHex === "string")
            .sort((a, b) => b.createdAt - a.createdAt);
    } catch {
        return [];
    }
};

// persistence must never fail the caller: by the time a swap is stored the
// funding tx is already broadcast, and the offer stays recoverable from it
const saveSwapSafely = async (repository: AssetSwapRepository, swap: AssetSwap): Promise<void> => {
    try {
        await repository.saveSwap(swap);
    } catch {
        // best effort: the record stays recoverable from chain (see restore.ts)
    }
};

/** Add a swap; no-op if the id is already stored. Returns the updated list. */
export const addAssetSwap = async (
    repository: AssetSwapRepository,
    swap: AssetSwap,
): Promise<AssetSwap[]> => {
    const swaps = await getAssetSwaps(repository);
    if (swaps.some((s) => s.id === swap.id)) return swaps;
    await saveSwapSafely(repository, swap);
    return [swap, ...swaps].sort((a, b) => b.createdAt - a.createdAt);
};

/** Merge changes into a swap by id. Returns the updated list. */
export const updateAssetSwap = async (
    repository: AssetSwapRepository,
    id: string,
    // the id is the storage key: rewriting it here would leave the original
    // record stored under the old key and report one swap twice
    changes: Partial<Omit<AssetSwap, "id">>,
): Promise<AssetSwap[]> => {
    const swaps = (await getAssetSwaps(repository)).map((s) =>
        s.id === id ? { ...s, ...changes } : s,
    );
    const updated = swaps.find((s) => s.id === id);
    if (updated) await saveSwapSafely(repository, updated);
    return swaps;
};
