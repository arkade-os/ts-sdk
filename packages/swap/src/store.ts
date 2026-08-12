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

export interface AssetSwapFallbackSecretsV1 {
    version: 1;
    type: "stored";
    senderPrivateKeyHex: string;
    /** Onchain-send only. A lightning send's preimage belongs to the payee. */
    preimageHex?: string;
}

export type AssetSwapFallbackSecrets = AssetSwapFallbackSecretsV1;

// ponytail: records carry only chain-recoverable facts — no quote-time display
// snapshot (tickers, fee bps, fiat value); add an optional snapshot field back
// if a consumer must persist display metadata the restore scan cannot rebuild

// ponytail: store policy (newest-first order, insert-if-absent, id-is-the-key,
// write-failure reporting) lives in these repository-first functions, so a
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
     * The sender/payout key is the creating wallet's identity key — set
     * instead of `signingDescriptor` on wallets that cannot allocate. Public,
     * like the descriptor: the key needs no persistence because the wallet
     * *is* the key. A preimage on this arm is random, so `preimageHex` is
     * mandatory wherever the flow carries one.
     */
    identityKey?: true;
    /** P, hex, when the user supplied a preimage that is not seed-derived. */
    preimageHex?: string;
    /**
     * Complete stored-arm secrets for wallets that cannot derive. Versioned
     * and discriminated so restore can rebuild both the sender identity and,
     * for onchain sends, P.
     */
    fallbackSecrets?: AssetSwapFallbackSecrets;
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
 * newest-first canonical for every consumer. */
export const getAssetSwapsOrThrow = async (
    repository: AssetSwapRepository,
): Promise<AssetSwap[]> => {
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
};

/** The consumer read: a broken backend reads as no swaps rather than crashing
 * a history view. Mutations must use {@link getAssetSwapsOrThrow} instead —
 * swallowing the read there would let "the backend is gone" masquerade as "no
 * such swap" and skip the write silently. */
export const getAssetSwaps = async (repository: AssetSwapRepository): Promise<AssetSwap[]> => {
    try {
        return await getAssetSwapsOrThrow(repository);
    } catch {
        return [];
    }
};

// Surface persistence failures: the caller decides what a lost write means.
const saveSwapOrThrow = async (repository: AssetSwapRepository, swap: AssetSwap): Promise<void> => {
    try {
        await repository.saveSwap(swap);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`failed to save swap ${swap.id}: ${reason}`);
    }
};

/** Add a swap; no-op if the id is already stored. Returns the updated list.
 * THROWS on a failed write — nothing irreversible may happen until this record
 * is durable, so the caller must not fund on a failure. */
export const addAssetSwap = async (
    repository: AssetSwapRepository,
    swap: AssetSwap,
): Promise<AssetSwap[]> => {
    const swaps = await getAssetSwapsOrThrow(repository);
    if (swaps.some((s) => s.id === swap.id)) return swaps;
    await saveSwapOrThrow(repository, swap);
    // the list is already newest-first, so place the one new record rather than
    // re-sorting the whole history around it
    const at = swaps.findIndex((s) => byNewest(swap, s) <= 0);
    const merged = [...swaps];
    merged.splice(at === -1 ? merged.length : at, 0, swap);
    return merged;
};

/** Merge changes into a swap by id. Returns the updated list.
 * THROWS on a failed read or write, like {@link addAssetSwap} — use this for a
 * write that gates something irreversible. Transitions written *after* the
 * irreversible act belong on {@link updateAssetSwapBestEffort}. */
export const updateAssetSwap = async (
    repository: AssetSwapRepository,
    id: string,
    // the id is the storage key: rewriting it here would leave the original
    // record stored under the old key and report one swap twice
    changes: Partial<Omit<AssetSwap, "id">>,
): Promise<AssetSwap[]> => {
    const swaps = (await getAssetSwapsOrThrow(repository)).map((s) =>
        s.id === id ? { ...s, ...changes } : s,
    );
    const updated = swaps.find((s) => s.id === id);
    if (updated) await saveSwapOrThrow(repository, updated);
    return swaps;
};

/**
 * {@link updateAssetSwap} for transitions that follow an irreversible action (a
 * broadcast claim, a spent lockup): failing the caller there would report as
 * failed a swap whose funds already moved, and a stale status is recoverable —
 * crash recovery re-derives the true state from the chain
 * (`classifyOnchainHtlc`).
 *
 * `persisted` is the part that must not be hidden: a caller that notifies on a
 * change, or treats one as terminal, has to know the store did not agree.
 */
export const updateAssetSwapBestEffort = async (
    repository: AssetSwapRepository,
    id: string,
    changes: Partial<Omit<AssetSwap, "id">>,
): Promise<{ swaps: AssetSwap[]; persisted: boolean }> => {
    try {
        return { swaps: await updateAssetSwap(repository, id, changes), persisted: true };
    } catch (error) {
        console.warn(`[swap] failed to persist update for swap ${id}`, error);
        // the read may be what failed, so report the merge over what we can
        // still see rather than claiming an empty history
        const swaps = (await getAssetSwaps(repository)).map((s) =>
            s.id === id ? { ...s, ...changes } : s,
        );
        return { swaps, persisted: false };
    }
};
