import {
    WalletRepository,
    WalletState,
} from "../repositories/walletRepository";

/** Lag behind real-time to avoid racing with indexer writes. */
export const SAFETY_LAG_MS = 30_000;

/** Overlap window so boundary virtual outputs are never missed. */
export const OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * Per-repository mutex that serializes wallet-state mutations so that
 * concurrent read-modify-write cycles never silently overwrite
 * each other's changes.
 */
const walletStateLocks = new WeakMap<WalletRepository, Promise<void>>();

/**
 * Atomically read, mutate, and persist wallet state.
 * All callers that modify wallet state should go through this helper
 * to avoid lost-update races between interleaved async operations.
 */
export async function updateWalletState(
    repo: WalletRepository,
    updater: (state: WalletState) => WalletState
): Promise<void> {
    const prev = walletStateLocks.get(repo) ?? Promise.resolve();
    const op = prev.then(async () => {
        const state = (await repo.getWalletState()) ?? {};
        await repo.saveWalletState(updater(state));
    });
    // Store a version that never rejects so the chain doesn't break.
    walletStateLocks.set(
        repo,
        op.catch(() => {})
    );
    return op;
}

/**
 * Read the global high-water mark for VTXO indexer syncs.
 * Returns `0` when the wallet has never been synced (bootstrap case).
 */
export async function getSyncCursor(repo: WalletRepository): Promise<number> {
    const state = await repo.getWalletState();
    return state?.vtxosIndexerUpdatedAt ?? 0;
}

/**
 * Advance the global cursor after a successful full-scope delta sync.
 */
export async function advanceSyncCursor(
    repo: WalletRepository,
    lastUpdatedAt: number
): Promise<void> {
    await updateWalletState(repo, (state) => {
        return {
            ...state,
            vtxosIndexerUpdatedAt: lastUpdatedAt,
        };
    });
}

/**
 * Remove the sync cursor, forcing a full re-bootstrap on next sync.
 */
export async function clearSyncCursor(repo: WalletRepository): Promise<void> {
    await updateWalletState(repo, (state) => {
        return {
            ...state,
            vtxosIndexerUpdatedAt: undefined,
        };
    });
}

/**
 * Compute the `after` lower-bound for a delta sync query.
 *
 * No upper bound (`before`) is applied to the query so that freshly
 * created virtual outputs are never excluded. The safety lag is applied only
 * when advancing the cursor (see @see cursorCutoff).
 */
export function computeSyncWindow(cursor: number): { after: number } {
    const after = Math.max(0, cursor - OVERLAP_MS);
    return { after };
}

/**
 * The safe high-water mark for cursor advancement.
 * Lags behind real-time by @see SAFETY_LAG_MS so that virtual outputs still
 * being indexed are re-queried on the next sync.
 *
 * When `requestStartedAt` is provided the cutoff is frozen to the
 * request start rather than wall-clock at commit time, preventing
 * long-running paginated fetches from advancing the cursor past the
 * data they actually observed.
 */
export function cursorCutoff(requestStartedAt?: number): number {
    return (requestStartedAt ?? Date.now()) - SAFETY_LAG_MS;
}
