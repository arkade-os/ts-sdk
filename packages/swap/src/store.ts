import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { contractPreimage } from "@arkade-os/sdk";
import type { IWallet, ProvisionedClaimSecret, ProvisionedKey } from "@arkade-os/sdk";
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
// write-failure reporting) lives in these repository-first functions, so a
// consumer calling repository.saveSwap directly bypasses all of it — saveSwap
// is an upsert, so it will not even preserve insert-if-absent. Promote to an
// AssetSwapStore class holding the repository privately if a second consumer
// starts writing swaps, or the first invariant gets violated in practice.

/**
 * The record fields a wallet-provisioned secret becomes — what
 * {@link swapSecretsToRecord} emits, and what every record type carrying swap
 * secrets embeds.
 *
 * A named type rather than four fields restated per record: the mapper and the
 * records it feeds must agree exactly, and a record that silently omits one of
 * these round-trips a swap whose preimage cannot be re-derived. Embedding makes
 * the omission a compile error instead.
 *
 * **Only `preimageHex` is secret.** `signingDescriptor` and `preimageSaltHex`
 * are public derivation inputs — they must survive a field-mapped backend, but
 * they leak nothing without the seed.
 */
export interface SwapSecretsProjection {
    /**
     * The wallet descriptor this swap's sender key comes from — a fresh HD
     * child, or a static wallet's `tr(pubkey)`. Public — the signer
     * re-derives from the wallet, so the record carries no key material.
     */
    signingDescriptor?: string;
    /** P, hex, when it cannot be re-derived from the seed at all: the user
     * supplied it, or the signer cannot sign deterministically. The swap's only
     * claim secret when present. */
    preimageHex?: string;
    /**
     * The salt P derives from, hex, on the salted arm — what a static wallet
     * gets instead of storing P. **Public**, and unlike every other field here
     * it is minted per swap: it is what stops one repeating key from handing
     * every swap the same preimage.
     */
    preimageSaltHex?: string;
}

export interface AssetSwap extends SwapSecretsProjection {
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

/**
 * The record fields a wallet-provisioned secret becomes.
 *
 * `signingDescriptor` is public and always stored — it is what recovers the
 * signer. Then at most one of: `preimageHex`, when the wallet says it cannot
 * re-derive P and it becomes the swap's only claim secret; or
 * `preimageSaltHex`, the public input a derivable-but-repeating key needs.
 */
export const swapSecretsToRecord = (
    secrets: ProvisionedKey | ProvisionedClaimSecret,
): SwapSecretsProjection & { signingDescriptor: string } => ({
    signingDescriptor: secrets.descriptor,
    ...("mustPersistPreimage" in secrets && secrets.mustPersistPreimage
        ? { preimageHex: hex.encode(secrets.preimage) }
        : {}),
    ...("preimageSalt" in secrets && secrets.preimageSalt
        ? { preimageSaltHex: hex.encode(secrets.preimageSalt) }
        : {}),
});

/** 32 bytes of hex, or a message naming the field that was wrong. */
const decodeHex32 = (value: string, field: string): Uint8Array => {
    const bytes = hex.decode(value);
    if (bytes.length !== 32) {
        throw new Error(`${field} must be 32 bytes, got ${bytes.length}`);
    }
    return bytes;
};

/**
 * The preimage a swap record claims with — stored, or re-derived from the
 * wallet.
 *
 * The record-shaped inverse of {@link swapSecretsToRecord}, and the one place
 * that knows which of a record's fields `contractPreimage` needs. Wire claim
 * paths here rather than composing it by hand: a caller that forgets to pass
 * `preimageSaltHex` gets a *wrong* preimage from a wallet that can derive,
 * not an error.
 *
 * Verifies the result against `paymentHash` when the record carries one. The
 * salted arm has two inputs that can be wrong — the key and the salt — where
 * the HD arm had one, and a wrong P otherwise surfaces as an opaque script
 * failure at claim time, long after the mistake.
 */
export const preimageForSwapRecord = async (
    wallet: IWallet,
    record: SwapSecretsProjection & { paymentHash?: string },
): Promise<Uint8Array> => {
    if (!record.signingDescriptor) {
        throw new Error("this swap record carries no signing descriptor");
    }
    const preimage = await contractPreimage(wallet, record.signingDescriptor, {
        stored: record.preimageHex ? decodeHex32(record.preimageHex, "preimageHex") : undefined,
        salt: record.preimageSaltHex
            ? decodeHex32(record.preimageSaltHex, "preimageSaltHex")
            : undefined,
    });
    if (record.paymentHash && hex.encode(sha256(preimage)) !== record.paymentHash) {
        throw new Error(
            "the derived preimage does not match this swap's payment hash: wrong wallet, or a tampered salt",
        );
    }
    return preimage;
};
