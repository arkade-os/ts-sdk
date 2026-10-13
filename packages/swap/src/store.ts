import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { contractPreimage } from "@arkade-os/sdk";
import type { IWallet, ProvisionedClaimSecret, ProvisionedKey } from "@arkade-os/sdk";
import { collectAssetSwaps, type AssetSwapRepository } from "./repository";

/** @deprecated Use `Outcome`. Moved off the package root to `@arkade-os/swap/protocol`. */
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

/** The sentinel asset id for BTC itself, as opposed to a 68-hex asset id. */
export const BTC_ASSET_ID = "btc";

// ponytail: records carry only chain-recoverable facts — no quote-time display
// snapshot (tickers, fee bps, fiat value); add an optional snapshot field back
// if a consumer must persist display metadata the restore scan cannot rebuild

// ponytail: store policy (newest-first, insert-if-absent, id-is-the-key, write-failure reporting)
// lives in these functions, so a direct repository.saveSwap (an upsert) bypasses it. Promote to an
// AssetSwapStore class holding the repository privately if a second consumer starts writing swaps.

/**
 * The record fields a wallet-provisioned secret becomes; every secret-carrying record embeds it, so
 * omitting one (an unrecoverable preimage) is a compile error. **Only `preimageHex` is secret**; the
 * descriptor and salt are public derivation inputs that leak nothing without the seed.
 */
export interface SwapSecretsProjection {
    /** The wallet descriptor this swap's sender key comes from (a fresh HD child, or a static
     * wallet's `tr(pubkey)`). Public; the record carries no key material. */
    signingDescriptor?: string;
    /** P, hex, when it cannot be re-derived from the seed at all: the user
     * supplied it, or the signer cannot sign deterministically. The swap's only
     * claim secret when present. */
    preimageHex?: string;
    /** The salt P derives from, hex — what a static wallet stores instead of P. **Public**, and minted
     * per swap: it stops one repeating key from giving every swap the same preimage. */
    preimageSaltHex?: string;
}

/** The row {@link AssetSwapRepository} stores. A root export because custom storage backends are
 * written against it. Not the v2 client's record (that is `SwapRecord`, projected as `Swap`). */
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

const byNewest = (a: AssetSwap, b: AssetSwap): number => b.createdAt - a.createdAt;

/** All swaps, newest-first. Sorted at read because the restore scan inserts in tx-scan order. */
export const getAssetSwapsOrThrow = async (
    repository: AssetSwapRepository,
): Promise<AssetSwap[]> => {
    return (await collectAssetSwaps(repository))
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

/** The consumer read: a broken backend reads as no swaps rather than crashing a history view.
 * Mutations must use {@link getAssetSwapsOrThrow}, or "backend gone" would masquerade as "no such
 * swap" and skip the write silently. */
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
 * is durable, so the caller must not fund on a failure.
 *
 * @deprecated `accept()` writes the record; read it with `client.swaps()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export const addAssetSwap = async (
    repository: AssetSwapRepository,
    swap: AssetSwap,
): Promise<AssetSwap[]> => {
    const swaps = await getAssetSwapsOrThrow(repository);
    if (swaps.some((s) => s.id === swap.id)) return swaps;
    await saveSwapOrThrow(repository, swap);
    const at = swaps.findIndex((s) => byNewest(swap, s) <= 0);
    const merged = [...swaps];
    merged.splice(at === -1 ? merged.length : at, 0, swap);
    return merged;
};

/** Merge changes into a swap by id. Returns the updated list. THROWS on a failed read or write —
 * use it for a write that gates something irreversible; writes *after* the irreversible act belong
 * on {@link updateAssetSwapBestEffort}.
 *
 * @deprecated `accept()` writes the record; read it with `client.swaps()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
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
 * {@link updateAssetSwap} for transitions after an irreversible action (a broadcast claim, a spent
 * lockup): failing there would report a swap whose funds already moved as failed, and a stale status
 * is recoverable from chain (`classifyOnchainHtlc`). `persisted` must not be hidden: a caller that
 * notifies on or finalizes a change has to know the store did not agree.
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
        // the read may be what failed: merge over what is still visible rather than claim empty
        const swaps = (await getAssetSwaps(repository)).map((s) =>
            s.id === id ? { ...s, ...changes } : s,
        );
        return { swaps, persisted: false };
    }
};

/**
 * The record fields a wallet-provisioned secret becomes: `signingDescriptor` always, then at most
 * one of `preimageHex` (the wallet cannot re-derive P) or `preimageSaltHex` (derivable but
 * repeating key).
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

/** Why a wallet cannot produce a swap's preimage. */
export type PreimageBlockedReason =
    /** The record carries no `signingDescriptor`. */
    | "no-secrets"
    /** `preimageHex` or `preimageSaltHex` is present but not 32 bytes of hex. */
    | "malformed-record"
    /** Nothing to derive from, or a descriptor this wallet holds no key for — merged because
     * `contractSigner` reports the latter inconsistently; `cause` carries which. */
    | "not-derivable"
    /** Derived, but it does not hash to the record's `paymentHash`. */
    | "hash-mismatch";

/**
 * The wallet cannot produce this swap's preimage; `reason` says which way.
 *
 * Deliberately **not** {@link RefundNotLocallyPossibleError}: `RfqSwapManager` reports that as
 * `needs_counterparty`, and a claim-path read failure is a different verdict.
 */
export class PreimageNotRecoverableError extends Error {
    override readonly name = "PreimageNotRecoverableError";
    constructor(
        readonly reason: PreimageBlockedReason,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
    }
}

/**
 * The preimage a swap record claims with — stored, or re-derived. Use this rather than composing by
 * hand: forgetting `preimageSaltHex` yields a *wrong* preimage, not an error. Verified against
 * `paymentHash` when present, since a wrong P otherwise surfaces as an opaque script failure at
 * claim time. Every refusal is a {@link PreimageNotRecoverableError} with a `reason`.
 */
export const preimageForSwapRecord = async (
    wallet: IWallet,
    record: SwapSecretsProjection & { paymentHash?: string },
): Promise<Uint8Array> => {
    if (!record.signingDescriptor) {
        throw new PreimageNotRecoverableError(
            "no-secrets",
            "this swap record carries no signing descriptor",
        );
    }
    // outside the derivation try: a malformed record is the caller's bug, not "cannot derive"
    let stored: Uint8Array | undefined;
    let salt: Uint8Array | undefined;
    try {
        stored = record.preimageHex ? decodeHex32(record.preimageHex, "preimageHex") : undefined;
        salt = record.preimageSaltHex
            ? decodeHex32(record.preimageSaltHex, "preimageSaltHex")
            : undefined;
    } catch (cause) {
        throw new PreimageNotRecoverableError(
            "malformed-record",
            `this swap record's secrets projection is unreadable: ${String(cause)}`,
            { cause },
        );
    }

    let preimage: Uint8Array;
    try {
        preimage = await contractPreimage(wallet, record.signingDescriptor, { stored, salt });
    } catch (cause) {
        throw new PreimageNotRecoverableError(
            "not-derivable",
            `this wallet cannot produce the preimage for ${record.signingDescriptor}`,
            { cause },
        );
    }

    // case-folded: a backend that uppercases hex round-trips salt and preimage fine (`hex.decode`
    // accepts either) and would otherwise fail only here, with a spurious hash-mismatch
    if (record.paymentHash && hex.encode(sha256(preimage)) !== record.paymentHash.toLowerCase()) {
        throw new PreimageNotRecoverableError(
            "hash-mismatch",
            "the derived preimage does not match this swap's payment hash: wrong wallet, or a tampered salt",
        );
    }
    return preimage;
};
