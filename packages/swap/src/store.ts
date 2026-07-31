import { getStorageItem, setStorageItemSafely, type SwapStorage } from "./storage";

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

const KEY = "assetSwaps";

export const getAssetSwaps = (storage: SwapStorage): AssetSwap[] => {
    return getStorageItem(storage, KEY, [], (val) => {
        const parsed = JSON.parse(val);
        if (!Array.isArray(parsed)) return [];
        // insertion order is not chronological — the restore scan rebuilds records
        // in tx-scan order — so sort at read to keep newest-first canonical for
        // every consumer (including the activity merge)
        return parsed
            .filter((s) => s && typeof s.id === "string" && typeof s.offerHex === "string")
            .sort((a, b) => b.createdAt - a.createdAt);
    });
};

// persistence must never fail the caller: by the time a swap is stored the
// funding tx is already broadcast, and the offer stays recoverable from it
const saveAssetSwaps = (storage: SwapStorage, swaps: AssetSwap[]): void => {
    setStorageItemSafely(storage, KEY, JSON.stringify(swaps));
};

/** Prepend a swap; no-op if the id is already stored. */
export const addAssetSwap = (storage: SwapStorage, swap: AssetSwap): AssetSwap[] => {
    const swaps = getAssetSwaps(storage);
    if (!swaps.some((s) => s.id === swap.id)) swaps.unshift(swap);
    saveAssetSwaps(storage, swaps);
    return swaps;
};

export const updateAssetSwap = (
    storage: SwapStorage,
    id: string,
    changes: Partial<AssetSwap>,
): AssetSwap[] => {
    const swaps = getAssetSwaps(storage).map((s) => (s.id === id ? { ...s, ...changes } : s));
    saveAssetSwaps(storage, swaps);
    return swaps;
};
