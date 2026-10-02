import { WalletRepository, WalletState } from "../repositories/walletRepository";

/** Lag behind real-time to avoid racing with indexer writes. */
export const SAFETY_LAG_MS = 30_000;

/** Overlap window so boundary virtual outputs are never missed. */
export const OVERLAP_MS = 24 * 60 * 60 * 1000;

/** Per-repository mutex serializing wallet-state read-modify-write cycles. */
const walletStateLocks = new WeakMap<WalletRepository, Promise<void>>();

/**
 * Atomically read, mutate, and persist wallet state. Every wallet-state writer must go through
 * this to avoid lost updates between interleaved async operations.
 */
export async function updateWalletState(
    repo: WalletRepository,
    updater: (state: WalletState) => WalletState,
): Promise<void> {
    const prev = walletStateLocks.get(repo) ?? Promise.resolve();
    const op = prev.then(async () => {
        const state = (await repo.getWalletState()) ?? {};
        await repo.saveWalletState(updater(state));
    });
    // Store a version that never rejects so the chain doesn't break.
    walletStateLocks.set(
        repo,
        op.catch(() => {}),
    );
    return op;
}

/**
 * Settings key gating `lastSyncTime`. Older versions wrote that field with a different meaning
 * (wall-clock at sync completion), so it is only trusted once an advance has written this marker.
 * Stored in the `settings` blob to avoid a schema migration.
 */
const CURSOR_MIGRATED_KEY = "vtxoCursorMigrated";

function hasMigrationMarker(state: WalletState | null | undefined): boolean {
    return state?.settings?.[CURSOR_MIGRATED_KEY] === true;
}

/**
 * Read the global high-water mark for VTXO indexer syncs; `0` when never synced or the stored
 * value predates {@link CURSOR_MIGRATED_KEY}.
 */
export async function getSyncCursor(repo: WalletRepository): Promise<number> {
    const state = await repo.getWalletState();
    if (!hasMigrationMarker(state)) return 0;
    return state?.lastSyncTime ?? 0;
}

/**
 * Advance the global cursor after a successful full-scope delta sync. `Math.max`-clamped because
 * `lastUpdatedAt` is captured before entering the mutex, so out-of-order finishes would rewind
 * it. A legacy (unmarked) value is discarded rather than compared against.
 */
export async function advanceSyncCursor(
    repo: WalletRepository,
    lastUpdatedAt: number,
): Promise<void> {
    await updateWalletState(repo, (state) => {
        const current = hasMigrationMarker(state) ? (state.lastSyncTime ?? 0) : 0;
        return {
            ...state,
            lastSyncTime: Math.max(current, lastUpdatedAt),
            settings: {
                ...(state.settings ?? {}),
                [CURSOR_MIGRATED_KEY]: true,
            },
        };
    });
}

/** Remove the sync cursor and its migration marker, forcing a full re-bootstrap on next sync. */
export async function clearSyncCursor(repo: WalletRepository): Promise<void> {
    await updateWalletState(repo, (state) => {
        const { [CURSOR_MIGRATED_KEY]: _, ...restSettings } = state.settings ?? {};
        return {
            ...state,
            lastSyncTime: undefined,
            settings: restSettings,
        };
    });
}

/**
 * Compute the `after` lower-bound for a delta sync query. No `before` bound, so fresh virtual
 * outputs are never excluded; the safety lag applies only to {@link cursorCutoff}.
 */
export function computeSyncWindow(cursor: number): { after: number } {
    const after = Math.max(0, cursor - OVERLAP_MS);
    return { after };
}

/**
 * Safe high-water mark for cursor advancement, lagging by {@link SAFETY_LAG_MS} so outputs still
 * being indexed are re-queried. Anchor to `requestStartedAt` so a long paginated fetch can't
 * advance past the data it actually observed.
 */
export function cursorCutoff(requestStartedAt?: number): number {
    return (requestStartedAt ?? Date.now()) - SAFETY_LAG_MS;
}
