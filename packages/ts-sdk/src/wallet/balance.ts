import type { Asset } from ".";
import type { NormalizedExtendedVirtualCoin, TimeHeight } from "./vtxo";
import { canRecoverOnchain, canSpendOffchain, hasTerminalSpend } from "./vtxo";

/**
 * The offchain half of {@link WalletBalance}, bucketed from one VTXO snapshot.
 *
 * @see computeOffchainBalance
 */
export interface OffchainBalance {
    settled: number;
    preconfirmed: number;
    available: number;
    /**
     * Spendable-but-for-the-gate funds: VTXOs under a contract
     * {@link BalanceCapabilities.isGenericallySpendable} refuses — a VHTLC
     * lockup, an unmarked `arkade` program, or a type whose handler this runtime
     * never registered. Counted in `settled`/`preconfirmed` and `total`, never
     * in `available`.
     *
     * Tested before {@link intentLocked}: the gate is a durable property of the
     * contract while an intent lock clears on its own, so a VTXO that is both is
     * reported here — it does not become available when the batch settles.
     */
    gated: number;
    /**
     * Funds committed to an in-flight (non-terminal) intent, and not already
     * counted in {@link gated}. Unlike `gated`, these return to `available` when
     * the intent reaches a terminal state.
     *
     * Reported as zero where the caller cannot answer the question — a wallet
     * with no intent repository, or a repository read that fails — so this
     * under-reports into `available` rather than misattributing. The two callers
     * answer from deliberately different reads (see {@link BalanceCapabilities}),
     * so a worker figure and a main-thread figure need not agree unless taken
     * over the same state.
     */
    intentLocked: number;
    recoverable: number;
    pendingRecovery: number;
    /** `settled + preconfirmed + recoverable + pendingRecovery` — the buckets are disjoint. */
    total: number;
    assets: Asset[];
    availableAssets: Asset[];
}

/**
 * Per-VTXO facts the bucketing rules need but cannot derive offline from the
 * VTXO alone. Each caller supplies them from its own read strategy — the
 * main-thread balance from a synced contract snapshot, the service worker from
 * a pure repository read — so the *rules* stay shared while the *freshness*
 * stays deliberately different.
 */
export interface BalanceCapabilities {
    now: TimeHeight;
    /** Past-cutoff deprecated-signer funds awaiting recovery. */
    isPendingRecovery: (vtxo: NormalizedExtendedVirtualCoin) => boolean;
    /** The generic-spending gate. @see isContractGenericallySpendable */
    isGenericallySpendable: (vtxo: NormalizedExtendedVirtualCoin) => boolean;
    /** Not committed to an in-flight (non-terminal) intent. */
    isUnlocked: (vtxo: NormalizedExtendedVirtualCoin) => boolean;
}

/**
 * Bucket a VTXO snapshot into the offchain balance.
 *
 * Owned vs spendable is the whole shape here. `settled`/`preconfirmed`/`total`
 * and `assets` count everything the wallet owns — escrowed funds are still the
 * user's funds. `available` and `availableAssets` count only what generic
 * spending would actually pick, so nothing reported as available can be refused
 * by `send`.
 *
 * Terminally spent VTXOs are skipped outright: neither capability predicate
 * claims them, and they must not reach the asset rollup.
 */
export function computeOffchainBalance(
    vtxos: readonly NormalizedExtendedVirtualCoin[],
    caps: BalanceCapabilities,
): OffchainBalance {
    const { now, isPendingRecovery, isGenericallySpendable, isUnlocked } = caps;

    let settled = 0;
    let preconfirmed = 0;
    let available = 0;
    let gated = 0;
    let intentLocked = 0;
    let recoverable = 0;
    let pendingRecovery = 0;
    const owned = new Map<string, bigint>();
    const spendable = new Map<string, bigint>();

    const addAssets = (into: Map<string, bigint>, vtxo: NormalizedExtendedVirtualCoin) => {
        for (const asset of vtxo.assets ?? []) {
            into.set(asset.assetId, (into.get(asset.assetId) ?? 0n) + asset.amount);
        }
    };

    for (const vtxo of vtxos) {
        if (hasTerminalSpend(vtxo)) continue;
        addAssets(owned, vtxo);

        // Pending recovery is tested first, and before expiry: such funds cannot
        // be renewed until they recover, so once their batch expiry passes
        // `canRecoverOnchain` would otherwise report them as renewable-right-now.
        // The branches are exclusive, so `total` counts each VTXO once — which is
        // also why the gate is applied to `available` alone and not here: a gated
        // coin dropping out of `recoverable` would meet `canSpendOffchain`, be
        // false there too, and land in no bucket at all.
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
        // Disjoint by construction, so `settled + preconfirmed` splits exactly
        // three ways. Gate before lock: see `gated`.
        if (!isGenericallySpendable(vtxo)) {
            gated += vtxo.value;
        } else if (!isUnlocked(vtxo)) {
            intentLocked += vtxo.value;
        } else {
            available += vtxo.value;
            addAssets(spendable, vtxo);
        }
    }

    const toAssets = (from: Map<string, bigint>): Asset[] =>
        Array.from(from.entries()).map(([assetId, amount]) => ({ assetId, amount }));

    return {
        settled,
        preconfirmed,
        available,
        gated,
        intentLocked,
        recoverable,
        pendingRecovery,
        total: settled + preconfirmed + recoverable + pendingRecovery,
        assets: toAssets(owned),
        availableAssets: toAssets(spendable),
    };
}
