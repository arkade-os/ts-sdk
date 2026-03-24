import { WalletRepository } from "../repositories/walletRepository";

/** Lag behind real-time to avoid racing with indexer writes. */
export const SAFETY_LAG_MS = 30_000;

/** Overlap window so boundary VTXOs are never missed. */
export const OVERLAP_MS = 60_000;

type SyncCursors = Record<string, number>;

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
    const state = (await repo.getWalletState()) ?? {};
    const existing =
        (state.settings?.vtxoSyncCursors as SyncCursors | undefined) ?? {};
    await repo.saveWalletState({
        ...state,
        settings: {
            ...state.settings,
            vtxoSyncCursors: { ...existing, [script]: cursor },
        },
    });
}

/**
 * Advance cursors for multiple scripts in a single write.
 */
export async function advanceSyncCursors(
    repo: WalletRepository,
    updates: Record<string, number>
): Promise<void> {
    const state = (await repo.getWalletState()) ?? {};
    const existing =
        (state.settings?.vtxoSyncCursors as SyncCursors | undefined) ?? {};
    await repo.saveWalletState({
        ...state,
        settings: {
            ...state.settings,
            vtxoSyncCursors: { ...existing, ...updates },
        },
    });
}

/**
 * Remove all sync cursors, forcing a full re-bootstrap on next sync.
 */
export async function clearSyncCursors(repo: WalletRepository): Promise<void> {
    const state = (await repo.getWalletState()) ?? {};
    const { vtxoSyncCursors: _, ...restSettings } = state.settings ?? {};
    await repo.saveWalletState({
        ...state,
        settings: restSettings,
    });
}

/**
 * Compute the `after` and `before` bounds for a delta sync window.
 * Returns `undefined` when the script has no cursor (bootstrap needed).
 */
export function computeSyncWindow(
    cursor: number | undefined
): { after: number; before: number } | undefined {
    if (cursor === undefined) return undefined;
    const before = Date.now() - SAFETY_LAG_MS;
    const after = Math.max(0, cursor - OVERLAP_MS);
    return { after, before };
}
