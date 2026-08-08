import type { AssetSwapRepository } from "./repository";

export type AssetSwapStatus =
    | "pending"
    | "cancelling"
    | "fulfilled"
    | "cancelled"
    | "recoverable"
    // onchain-corridor phases (see onchainHtlc.ts):
    | "awaiting_fill"
    | "claimable"
    | "claimed"
    | "refunded_l1";

/** The sentinel asset id for BTC itself, as opposed to a 68-hex asset id.
 * Lives here with the {@link AssetSwap} fields it describes so the market and
 * restore layers share one spelling instead of re-typing the literal. */
export const BTC_ASSET_ID = "btc";

// ponytail: records carry only chain-recoverable facts — no quote-time display
// snapshot (tickers, fee bps, fiat value); add an optional snapshot field back
// if a consumer must persist display metadata the restore scan cannot rebuild

// ponytail: store policy (newest-first order, insert-if-absent, id-is-the-key,
// write-failure tolerance) lives in these repository-first functions, so a
// consumer calling repository.saveSwap directly bypasses all of it — saveSwap
// is an upsert, so it will not even preserve insert-if-absent. Promote to an
// AssetSwapStore class holding the repository privately if a second consumer
// starts writing swaps, or the first invariant gets violated in practice.

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
    // ── Onchain-corridor fields (absent on offer swaps). Persist the record
    // BEFORE funding: what claims the swap across restarts lives here, and
    // nothing on chain recovers it until the counterparty spends. ──
    /** RFQ pair string, e.g. `arkade:BTC->onchain:BTC`. */
    pair?: string;
    /** `sha256(P)`, hex. Public, and how a restore confirms a candidate
     * derivation is the right one. */
    paymentHash?: string;
    /**
     * The HD descriptor this swap's secrets derive from. Public — it is what
     * lets the record carry no secrets at all. Present iff the swap was
     * created on a wallet that can allocate.
     */
    signingDescriptor?: string;
    /**
     * P, hex. **Fallback only**, for wallets that cannot derive: an HD swap
     * carries `signingDescriptor` instead and must not write this.
     */
    preimageHex?: string;
    /** The L1 HTLC's pkScript, hex — the chain-watch key. */
    htlcPkScriptHex?: string;
    htlcLocktime?: number;
    /** The L1 funding txid, once observed. */
    l1Txid?: string;
}

/** The canonical swap order, declared once so every read agrees on it. */
const byNewest = (a: AssetSwap, b: AssetSwap): number => b.createdAt - a.createdAt;

/** All swaps, newest-first. Insertion order is not chronological — the restore
 * scan rebuilds records in tx-scan order — so sort at read to keep
 * newest-first canonical for every consumer. A broken backend reads as no
 * swaps rather than crashing the caller. */
export const getAssetSwaps = async (repository: AssetSwapRepository): Promise<AssetSwap[]> => {
    try {
        return (await repository.getAllSwaps())
            .filter(
                (s) =>
                    s &&
                    typeof s.id === "string" &&
                    // offer swaps carry the TLV; onchain-corridor swaps carry
                    // the payment hash instead — either marks a valid record
                    (typeof s.offerHex === "string" || typeof s.paymentHash === "string"),
            )
            .sort(byNewest);
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
    // the list is already newest-first, so place the one new record rather than
    // re-sorting the whole history around it
    const at = swaps.findIndex((s) => byNewest(swap, s) <= 0);
    const merged = [...swaps];
    merged.splice(at === -1 ? merged.length : at, 0, swap);
    return merged;
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
