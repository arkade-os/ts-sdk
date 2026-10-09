import type { Asset, ExtendedCoin, WalletBalance } from ".";
import type { NormalizedExtendedVirtualCoin, TimeHeight } from "./vtxo";
import { canRecoverOnchain, canSpendOffchain, isVtxoSpent } from "./vtxo";

/**
 * The offchain half of {@link WalletBalance}, bucketed from one VTXO snapshot.
 *
 * @see computeOffchainBalance
 */
export interface OffchainBalance {
    settled: number;
    preconfirmed: number;
    /** Plain sats generic spending can move (less one dust carrier if assets are available). */
    available: number;
    /**
     * VTXOs under a contract {@link BalanceCapabilities.isGenericallySpendable} refuses (VHTLC
     * lockup, unmarked `arkade` program, unregistered handler type). In `settled`/`preconfirmed`
     * and `total`, never in `available`. Takes precedence over {@link intentLocked}: the gate is
     * durable while an intent lock clears on its own.
     */
    gated: number;
    /**
     * Funds committed to an in-flight (non-terminal) intent and not {@link gated}; they return to
     * `available` when the intent terminates. Zero when the caller can't tell (no intent
     * repository, or its read fails), so it under-reports into `available` rather than
     * misattributing. Worker and main-thread figures come from different reads and may differ.
     */
    intentLocked: number;
    /** Held by `reserveVtxos` and neither gated nor intent-locked; never in `available`. */
    reserved: number;
    recoverable: number;
    pendingRecovery: number;
    /**
     * Already unilaterally exited: onchain behind its CSV, movable only by `completeUnroll`.
     * Never `available` or `recoverable` (a batch cannot lift an onchain output), but in `total`.
     */
    unrolled: number;
    /** `settled + preconfirmed + recoverable + pendingRecovery + unrolled` (disjoint buckets). */
    total: number;
    assets: Asset[];
    availableAssets: Asset[];
}

/**
 * Facts the bucketing rules can't derive offline from the VTXOs alone. Main thread supplies them
 * from a synced contract snapshot, the service worker from a pure repository read: shared rules,
 * deliberately different freshness.
 */
export interface BalanceCapabilities {
    now: TimeHeight;
    /** Past-cutoff deprecated-signer funds awaiting recovery. */
    isPendingRecovery: (vtxo: NormalizedExtendedVirtualCoin) => boolean;
    /** The generic-spending gate. @see isContractGenericallySpendable */
    isGenericallySpendable: (vtxo: NormalizedExtendedVirtualCoin) => boolean;
    /** Not committed to an in-flight (non-terminal) intent. */
    isUnlocked: (vtxo: NormalizedExtendedVirtualCoin) => boolean;
    /** Held by `reserveVtxos`; absent means nothing is held. */
    isReserved?: (vtxo: NormalizedExtendedVirtualCoin) => boolean;
    /**
     * Sats an asset output rides on (operator dust amount, via {@link getDustAmount}). `0n`
     * disables the carrier deduction from `available`.
     */
    dustCarrier: bigint;
}

/**
 * Bucket a VTXO snapshot into the offchain balance.
 *
 * `settled`/`preconfirmed`/`total`/`assets` count everything owned (escrow included);
 * `available`/`availableAssets` only what generic spending would pick, so `send` never refuses
 * anything reported available. Terminally spent VTXOs are skipped; unrolled ones are not spent
 * and stay in `total`/`assets`.
 */
export function computeOffchainBalance(
    vtxos: readonly NormalizedExtendedVirtualCoin[],
    caps: BalanceCapabilities,
): OffchainBalance {
    const { now, isPendingRecovery, isGenericallySpendable, isUnlocked, isReserved, dustCarrier } =
        caps;

    let settled = 0;
    let preconfirmed = 0;
    let available = 0;
    let gated = 0;
    let intentLocked = 0;
    let reserved = 0;
    let recoverable = 0;
    let pendingRecovery = 0;
    let unrolled = 0;
    const owned = new Map<string, bigint>();
    const spendable = new Map<string, bigint>();

    const addAssets = (into: Map<string, bigint>, vtxo: NormalizedExtendedVirtualCoin) => {
        for (const asset of vtxo.assets ?? []) {
            into.set(asset.assetId, (into.get(asset.assetId) ?? 0n) + asset.amount);
        }
    };

    for (const vtxo of vtxos) {
        // Both balance reads pass unspent rows only. Kept so a spent coin is never
        // counted from a snapshot that still carries one.
        if (isVtxoSpent(vtxo)) continue;
        addAssets(owned, vtxo);

        // Must precede `isPendingRecovery`: with `selectPendingRecoveryOutpoints`' own exclusion,
        // one of two independent guards keeping an exited coin out of pending recovery.
        if (vtxo.isUnrolled) {
            unrolled += vtxo.value;
            continue;
        }

        // Pending recovery before expiry: such funds can't renew until recovered, but past batch
        // expiry `canRecoverOnchain` would call them renewable. Branches are exclusive so `total`
        // counts each VTXO once; the gate applies to `available` only, since a gated coin dropped
        // from `recoverable` would also fail `canSpendOffchain` and land in no bucket.
        if (isPendingRecovery(vtxo)) {
            pendingRecovery += vtxo.value;
            continue;
        }
        if (canRecoverOnchain(vtxo, now)) {
            recoverable += vtxo.value;
            continue;
        }
        if (!canSpendOffchain(vtxo, now)) continue;

        if (vtxo.isPreconfirmed) {
            preconfirmed += vtxo.value;
        } else {
            settled += vtxo.value;
        }
        // `settled + preconfirmed` splits exactly four ways. Gate before lock: see `gated`.
        if (!isGenericallySpendable(vtxo)) {
            gated += vtxo.value;
        } else if (!isUnlocked(vtxo)) {
            intentLocked += vtxo.value;
        } else if (isReserved?.(vtxo)) {
            reserved += vtxo.value;
        } else {
            available += vtxo.value;
            addAssets(spendable, vtxo);
        }
    }

    // An available asset's dust carrier moves only with the asset, so one carrier's worth of
    // `available` is reserved while any assets are available.
    if (available > 0 && spendable.size > 0) {
        available = Math.max(0, available - Number(dustCarrier));
    }

    const toAssets = (from: Map<string, bigint>): Asset[] =>
        Array.from(from.entries()).map(([assetId, amount]) => ({ assetId, amount }));

    return {
        settled,
        preconfirmed,
        available,
        gated,
        intentLocked,
        reserved,
        recoverable,
        pendingRecovery,
        unrolled,
        total: settled + preconfirmed + recoverable + pendingRecovery + unrolled,
        assets: toAssets(owned),
        availableAssets: toAssets(spendable),
    };
}

/** Combine the boarding coins with an {@link OffchainBalance} into a {@link WalletBalance}. */
export function toWalletBalance(
    boardingUtxos: readonly ExtendedCoin[],
    offchain: OffchainBalance,
): WalletBalance {
    let confirmed = 0;
    let unconfirmed = 0;
    for (const utxo of boardingUtxos) {
        if (utxo.status.confirmed) {
            confirmed += utxo.value;
        } else {
            unconfirmed += utxo.value;
        }
    }
    const totalBoarding = confirmed + unconfirmed;

    return {
        boarding: {
            confirmed,
            unconfirmed,
            total: totalBoarding,
        },
        settled: offchain.settled,
        preconfirmed: offchain.preconfirmed,
        available: offchain.available,
        gated: offchain.gated,
        intentLocked: offchain.intentLocked,
        reserved: offchain.reserved,
        recoverable: offchain.recoverable,
        pendingRecovery: offchain.pendingRecovery,
        unrolled: offchain.unrolled,
        total: totalBoarding + offchain.total,
        assets: offchain.assets,
        availableAssets: offchain.availableAssets,
    };
}
