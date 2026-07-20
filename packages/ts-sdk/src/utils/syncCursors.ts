import { WalletRepository, WalletState } from "../repositories/walletRepository";

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
 * Read wallet state through the same per-repository mutex
 * {@link updateWalletState} uses, so the read is ordered against
 * in-flight read-modify-write cycles rather than observing one
 * half-applied.
 *
 * Use this over a bare `repo.getWalletState()` when the value read is
 * used to rebuild in-memory state that concurrent mutations also touch;
 * a plain read can land mid-cycle and reconstruct from a stale snapshot.
 */
export async function readWalletState(repo: WalletRepository): Promise<WalletState> {
    const prev = walletStateLocks.get(repo) ?? Promise.resolve();
    const op = prev.then(async () => (await repo.getWalletState()) ?? {});
    // Store a version that never rejects so the chain doesn't break.
    walletStateLocks.set(
        repo,
        op.then(
            () => {},
            () => {},
        ),
    );
    return op;
}

/**
 * Settings key that gates interpretation of the `lastSyncTime` field.
 *
 * The `lastSyncTime` column existed pre-PR with a different semantic
 * (wall-clock at sync completion, written by the buggy sync loop this
 * PR fixes). On upgrade we cannot trust any pre-existing value, so the
 * cursor is only honoured after the first successful post-upgrade
 * advance writes this marker into the `settings` JSON blob. Reusing
 * `settings` avoids any schema migration.
 */
const CURSOR_MIGRATED_KEY = "vtxoCursorMigrated";

function hasMigrationMarker(state: WalletState | null | undefined): boolean {
    return state?.settings?.[CURSOR_MIGRATED_KEY] === true;
}

/**
 * Read the global high-water mark for VTXO indexer syncs.
 *
 * Returns `0` when:
 *  - the wallet has never been synced (bootstrap case), or
 *  - the stored `lastSyncTime` was written by pre-PR code and is not
 *    safe to reuse under the new semantics (see {@link CURSOR_MIGRATED_KEY}).
 */
export async function getSyncCursor(repo: WalletRepository): Promise<number> {
    const state = await repo.getWalletState();
    if (!hasMigrationMarker(state)) return 0;
    return state?.lastSyncTime ?? 0;
}

/**
 * Advance the global cursor after a successful full-scope delta sync.
 *
 * Clamped with `Math.max` against the current value so concurrent syncs
 * that finish out of order can't rewind the cursor: `lastUpdatedAt` is
 * captured before each sync enters the `updateWalletState` mutex, and
 * the later-started sync would otherwise overwrite the earlier-captured
 * one with a smaller value. The legacy value is discarded on the first
 * advance if the migration marker is absent so pre-PR data doesn't
 * survive the upgrade.
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

/**
 * Remove the sync cursor, forcing a full re-bootstrap on next sync.
 *
 * Also clears the migration marker so any stored `lastSyncTime` is
 * treated as untrusted on the next read.
 */
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
