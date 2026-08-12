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

/**
 * Legacy stored-secrets arm. Older SDKs minted a random sender key when the
 * wallet could not allocate a descriptor and persisted it here, plaintext.
 * Read-only since the wallet became the only key source: existing records
 * stay refundable, but nothing writes this shape anymore.
 */
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
     * The wallet descriptor this swap's sender key comes from — a fresh HD
     * child, or a static wallet's `tr(pubkey)`. Public — the signer
     * re-derives from the wallet, so the record carries no key material.
     */
    signingDescriptor?: string;
    /** P, hex, when it cannot be re-derived from the seed: the user supplied
     * it, or the descriptor is static (shared across swaps, so a derived
     * preimage would collide). */
    preimageHex?: string;
    /**
     * Legacy stored-arm secrets written by older SDKs — see
     * {@link AssetSwapFallbackSecretsV1}. Read-only.
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
