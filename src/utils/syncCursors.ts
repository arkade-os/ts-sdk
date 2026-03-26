import {
    WalletRepository,
    WalletState,
} from "../repositories/walletRepository";

/** Lag behind real-time to avoid racing with indexer writes. */
export const SAFETY_LAG_MS = 30_000;

/** Overlap window so boundary VTXOs are never missed. */
export const OVERLAP_MS = 60_000;

type SyncCursors = Record<string, number>;

/**
 * Per-repository mutex that serializes wallet-state mutations so that
 * concurrent read-modify-write cycles (e.g. advanceSyncCursors racing
 * with clearSyncCursors or setPendingTxFlag) never silently overwrite
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
 * Read the high-water mark for a single script.
 * Returns `undefined` when the script has never been synced (bootstrap case).
 */
export async function getSyncCursor(
    repo: WalletRepository,
    script: string
): Promise<number | undefined> {
    const state = await repo.getWalletState();
    return (state?.settings?.vtxoSyncCursors as SyncCursors | undefined)?.[
        script
    ];
}

/**
 * Read cursors for every previously-synced script.
 */
export async function getAllSyncCursors(
    repo: WalletRepository
): Promise<SyncCursors> {
    const state = await repo.getWalletState();
    return (state?.settings?.vtxoSyncCursors as SyncCursors | undefined) ?? {};
}

/**
 * Advance the cursor for one script after a successful delta sync.
 * `cursor` should be the `before` cutoff used in the request.
 */
export async function advanceSyncCursor(
    repo: WalletRepository,
    script: string,
    cursor: number
): Promise<void> {
    await updateWalletState(repo, (state) => {
        const existing =
            (state.settings?.vtxoSyncCursors as SyncCursors | undefined) ?? {};
        return {
            ...state,
            settings: {
                ...state.settings,
                vtxoSyncCursors: { ...existing, [script]: cursor },
            },
        };
    });
}

/**
 * Advance cursors for multiple scripts in a single write.
 */
export async function advanceSyncCursors(
    repo: WalletRepository,
    updates: Record<string, number>
): Promise<void> {
    await updateWalletState(repo, (state) => {
        const existing =
            (state.settings?.vtxoSyncCursors as SyncCursors | undefined) ?? {};
        return {
            ...state,
            settings: {
                ...state.settings,
                vtxoSyncCursors: { ...existing, ...updates },
            },
        };
    });
}

/**
 * Remove sync cursors, forcing a full re-bootstrap on next sync.
 * When `scripts` is provided, only those cursors are cleared.
 */
export async function clearSyncCursors(
    repo: WalletRepository,
    scripts?: string[]
): Promise<void> {
    await updateWalletState(repo, (state) => {
        if (!scripts) {
            const { vtxoSyncCursors: _, ...restSettings } =
                state.settings ?? {};
            return {
                ...state,
                settings: restSettings,
            };
        }
        const existing =
            (state.settings?.vtxoSyncCursors as
                | Record<string, number>
                | undefined) ?? {};
        const filtered = { ...existing };
        for (const s of scripts) delete filtered[s];
        return {
            ...state,
            settings: {
                ...state.settings,
                vtxoSyncCursors: filtered,
            },
        };
    });
}

/**
 * Compute the `after` lower-bound for a delta sync query.
 * Returns `undefined` when the script has no cursor (bootstrap needed).
 *
 * No upper bound (`before`) is applied to the query so that freshly
 * created VTXOs are never excluded. The safety lag is applied only
 * when advancing the cursor (see {@link cursorCutoff}).
 */
export function computeSyncWindow(
    cursor: number | undefined
): { after: number } | undefined {
    if (cursor === undefined) return undefined;
    const after = Math.max(0, cursor - OVERLAP_MS);
    return { after };
}

/**
 * The safe high-water mark for cursor advancement.
 * Lags behind real-time by {@link SAFETY_LAG_MS} so that VTXOs still
 * being indexed are re-queried on the next sync.
 */
export function cursorCutoff(): number {
    return Date.now() - SAFETY_LAG_MS;
}
