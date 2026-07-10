import type { ArkInfo, ArkProvider, FeeInfo } from "../providers/ark";
import { isRetryableProviderError } from "../providers/availability";
import { ProviderUnavailableError } from "../providers/errors";
import type { WalletRepository } from "../repositories/walletRepository";
import { updateWalletState } from "../utils/syncCursors";

/**
 * Key under {@link WalletState.settings} holding the cached server-info
 * snapshot. Namespaced so it coexists with unrelated settings keys
 * (`hasPendingTx`, `vtxoCursorMigrated`, …).
 */
export const ARK_INFO_SNAPSHOT_KEY = "arkInfoSnapshot";

/**
 * A JSON-safe, versioned cache of the operator's {@link ArkInfo} metadata,
 * persisted so a previously synced wallet can still construct — derive its
 * network, signer-dependent scripts, address parameters, dust/fee policy, and
 * delays — while the operator's live `getInfo` is unreachable.
 *
 * This is NOT proof the operator is live: it is only enough to build the wallet
 * and interpret locally persisted state. Cooperative operations that need the
 * operator must revalidate live metadata or fail with a typed unavailable error.
 *
 * `bigint` fields are stored as decimal strings; `ArkInfo.serviceStatus` is
 * deliberately not cached (it is live operator-health state, not static
 * construction metadata) and is rehydrated as `{}`.
 */
export type StoredArkInfoSnapshot = {
    version: 1;
    savedAt: number;
    source: "arkade.getInfo";
    arkInfo: {
        network: string;
        signerPubkey: string;
        checkpointTapscript: string;
        forfeitAddress: string;
        forfeitPubkey: string;
        unilateralExitDelay: string;
        boardingExitDelay: string;
        sessionDuration: string;
        dust: string;
        fees: FeeInfo;
        digest: string;
        version: string;
        vtxoMinAmount: string;
        vtxoMaxAmount: string;
        utxoMinAmount: string;
        utxoMaxAmount: string;
        deprecatedSigners: Array<{ pubkey: string; cutoffDate: string }>;
        scheduledSession?: {
            duration: string;
            fees: FeeInfo;
            nextEndTime: string;
            nextStartTime: string;
            period: string;
        };
    };
};

/**
 * A stored snapshot exists but is structurally invalid (wrong version, missing
 * or wrong-typed fields, non-decimal bigint strings). This is a *terminal*
 * failure: a corrupt cache must fail the same way malformed live server-info
 * does, never silently fall through as if no cache were present.
 */
export class MalformedArkInfoSnapshotError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, { cause: options?.cause });
        this.name = "MalformedArkInfoSnapshotError";
    }
}

const CURRENT_VERSION = 1 as const;

/** Convert a live {@link ArkInfo} into its JSON-safe snapshot form. */
export function serializeArkInfoSnapshot(info: ArkInfo, savedAt: number): StoredArkInfoSnapshot {
    return {
        version: CURRENT_VERSION,
        savedAt,
        source: "arkade.getInfo",
        arkInfo: {
            network: info.network,
            signerPubkey: info.signerPubkey,
            checkpointTapscript: info.checkpointTapscript,
            forfeitAddress: info.forfeitAddress,
            forfeitPubkey: info.forfeitPubkey,
            unilateralExitDelay: info.unilateralExitDelay.toString(),
            boardingExitDelay: info.boardingExitDelay.toString(),
            sessionDuration: info.sessionDuration.toString(),
            dust: info.dust.toString(),
            fees: info.fees,
            digest: info.digest,
            version: info.version,
            vtxoMinAmount: info.vtxoMinAmount.toString(),
            vtxoMaxAmount: info.vtxoMaxAmount.toString(),
            utxoMinAmount: info.utxoMinAmount.toString(),
            utxoMaxAmount: info.utxoMaxAmount.toString(),
            deprecatedSigners: info.deprecatedSigners.map((s) => ({
                pubkey: s.pubkey,
                cutoffDate: s.cutoffDate.toString(),
            })),
            scheduledSession: info.scheduledSession
                ? {
                      duration: info.scheduledSession.duration.toString(),
                      fees: info.scheduledSession.fees,
                      nextEndTime: info.scheduledSession.nextEndTime.toString(),
                      nextStartTime: info.scheduledSession.nextStartTime.toString(),
                      period: info.scheduledSession.period.toString(),
                  }
                : undefined,
        },
    };
}

/**
 * Rehydrate an {@link ArkInfo} from a validated snapshot. Decimal strings
 * become `bigint`; `serviceStatus` is reset to `{}` (never cached — see
 * {@link StoredArkInfoSnapshot}).
 */
export function hydrateArkInfo(snapshot: StoredArkInfoSnapshot): ArkInfo {
    const a = snapshot.arkInfo;
    return {
        boardingExitDelay: BigInt(a.boardingExitDelay),
        checkpointTapscript: a.checkpointTapscript,
        deprecatedSigners: a.deprecatedSigners.map((s) => ({
            cutoffDate: BigInt(s.cutoffDate),
            pubkey: s.pubkey,
        })),
        digest: a.digest,
        dust: BigInt(a.dust),
        fees: a.fees,
        forfeitAddress: a.forfeitAddress,
        forfeitPubkey: a.forfeitPubkey,
        network: a.network,
        scheduledSession: a.scheduledSession
            ? {
                  duration: BigInt(a.scheduledSession.duration),
                  fees: a.scheduledSession.fees,
                  nextEndTime: BigInt(a.scheduledSession.nextEndTime),
                  nextStartTime: BigInt(a.scheduledSession.nextStartTime),
                  period: BigInt(a.scheduledSession.period),
              }
            : undefined,
        serviceStatus: {},
        sessionDuration: BigInt(a.sessionDuration),
        signerPubkey: a.signerPubkey,
        unilateralExitDelay: BigInt(a.unilateralExitDelay),
        utxoMaxAmount: BigInt(a.utxoMaxAmount),
        utxoMinAmount: BigInt(a.utxoMinAmount),
        version: a.version,
        vtxoMaxAmount: BigInt(a.vtxoMaxAmount),
        vtxoMinAmount: BigInt(a.vtxoMinAmount),
    };
}

const DECIMAL_STRING = /^-?\d+$/;

function assertString(value: unknown, path: string): asserts value is string {
    if (typeof value !== "string") {
        throw new MalformedArkInfoSnapshotError(`${path} must be a string`);
    }
}

function assertDecimalString(value: unknown, path: string): asserts value is string {
    assertString(value, path);
    if (!DECIMAL_STRING.test(value)) {
        throw new MalformedArkInfoSnapshotError(`${path} must be a decimal integer string`);
    }
}

function assertFeeInfo(value: unknown, path: string): asserts value is FeeInfo {
    if (typeof value !== "object" || value === null) {
        throw new MalformedArkInfoSnapshotError(`${path} must be an object`);
    }
    const fees = value as Record<string, unknown>;
    assertString(fees.txFeeRate, `${path}.txFeeRate`);
    if (typeof fees.intentFee !== "object" || fees.intentFee === null) {
        throw new MalformedArkInfoSnapshotError(`${path}.intentFee must be an object`);
    }
}

/**
 * Validate an untrusted stored value into a {@link StoredArkInfoSnapshot},
 * throwing {@link MalformedArkInfoSnapshotError} on any structural problem.
 */
export function parseStoredArkInfoSnapshot(raw: unknown): StoredArkInfoSnapshot {
    if (typeof raw !== "object" || raw === null) {
        throw new MalformedArkInfoSnapshotError("snapshot must be an object");
    }
    const snap = raw as Record<string, unknown>;
    if (snap.version !== CURRENT_VERSION) {
        throw new MalformedArkInfoSnapshotError(
            `unsupported snapshot version: ${String(snap.version)}`,
        );
    }
    if (typeof snap.savedAt !== "number") {
        throw new MalformedArkInfoSnapshotError("savedAt must be a number");
    }
    if (snap.source !== "arkade.getInfo") {
        throw new MalformedArkInfoSnapshotError(`unexpected source: ${String(snap.source)}`);
    }
    if (typeof snap.arkInfo !== "object" || snap.arkInfo === null) {
        throw new MalformedArkInfoSnapshotError("arkInfo must be an object");
    }
    const a = snap.arkInfo as Record<string, unknown>;

    for (const field of [
        "network",
        "signerPubkey",
        "checkpointTapscript",
        "forfeitAddress",
        "forfeitPubkey",
        "digest",
        "version",
    ]) {
        assertString(a[field], `arkInfo.${field}`);
    }
    for (const field of [
        "unilateralExitDelay",
        "boardingExitDelay",
        "sessionDuration",
        "dust",
        "vtxoMinAmount",
        "vtxoMaxAmount",
        "utxoMinAmount",
        "utxoMaxAmount",
    ]) {
        assertDecimalString(a[field], `arkInfo.${field}`);
    }
    assertFeeInfo(a.fees, "arkInfo.fees");

    if (!Array.isArray(a.deprecatedSigners)) {
        throw new MalformedArkInfoSnapshotError("arkInfo.deprecatedSigners must be an array");
    }
    a.deprecatedSigners.forEach((s: unknown, i: number) => {
        if (typeof s !== "object" || s === null) {
            throw new MalformedArkInfoSnapshotError(
                `arkInfo.deprecatedSigners[${i}] must be an object`,
            );
        }
        const signer = s as Record<string, unknown>;
        assertString(signer.pubkey, `arkInfo.deprecatedSigners[${i}].pubkey`);
        assertDecimalString(signer.cutoffDate, `arkInfo.deprecatedSigners[${i}].cutoffDate`);
    });

    if (a.scheduledSession !== undefined) {
        if (typeof a.scheduledSession !== "object" || a.scheduledSession === null) {
            throw new MalformedArkInfoSnapshotError("arkInfo.scheduledSession must be an object");
        }
        const s = a.scheduledSession as Record<string, unknown>;
        for (const field of ["duration", "nextEndTime", "nextStartTime", "period"]) {
            assertDecimalString(s[field], `arkInfo.scheduledSession.${field}`);
        }
        assertFeeInfo(s.fees, "arkInfo.scheduledSession.fees");
    }

    return raw as StoredArkInfoSnapshot;
}

/**
 * Read and validate the cached snapshot from the wallet repository.
 * Returns `null` when no snapshot has been persisted; throws
 * {@link MalformedArkInfoSnapshotError} when a stored snapshot is corrupt.
 */
export async function loadArkInfoSnapshot(
    repo: WalletRepository,
): Promise<StoredArkInfoSnapshot | null> {
    const state = await repo.getWalletState();
    const raw = state?.settings?.[ARK_INFO_SNAPSHOT_KEY];
    if (raw === undefined || raw === null) return null;
    return parseStoredArkInfoSnapshot(raw);
}

/**
 * Persist a fresh snapshot from live server-info, preserving all other
 * {@link WalletState.settings} keys. Serialized through the shared
 * {@link updateWalletState} mutex so it can't lose-update a concurrent
 * settings write.
 */
export async function saveArkInfoSnapshot(
    repo: WalletRepository,
    info: ArkInfo,
    savedAt: number,
): Promise<void> {
    const snapshot = serializeArkInfoSnapshot(info, savedAt);
    await updateWalletState(repo, (state) => ({
        ...state,
        settings: {
            ...(state.settings ?? {}),
            [ARK_INFO_SNAPSHOT_KEY]: snapshot,
        },
    }));
}

/** Where the {@link ArkInfo} used to construct a wallet came from. */
export type ServerInfoSource = "live" | "cache";

export interface ResolvedArkInfo {
    info: ArkInfo;
    /** `live` when fetched from the operator, `cache` when hydrated offline. */
    source: ServerInfoSource;
    /**
     * Epoch-ms of the last known live operator contact: the cached snapshot's
     * `savedAt` on the `cache` path, `undefined` on the `live` path (the caller
     * stamps "now" after it persists the validated snapshot).
     */
    lastOnlineAt?: number;
}

/**
 * Resolve the server-info needed to construct a wallet, with cache fallback.
 * **This never writes the cache** — persistence is deferred to
 * {@link saveValidatedArkInfoSnapshot}, called only once construction has
 * validated the response, so a terminal live response can't poison the cache.
 *
 *  - Live `getInfo` succeeds → return it as `source: "live"`. **Live wins.**
 *  - Live `getInfo` fails with a *retryable* provider error → hydrate the cached
 *    snapshot if present (`source: "cache"`); otherwise throw a typed
 *    {@link ProviderUnavailableError}.
 *  - Live `getInfo` fails *terminally* (4xx/config/schema), or a stored snapshot
 *    is malformed → propagate the terminal error; never silently fall back.
 *
 * Network validation is left to the caller and runs identically on either
 * source, so a cached snapshot for the wrong network fails the same way a live
 * wrong-network response does.
 */
export async function resolveArkInfo(
    arkProvider: Pick<ArkProvider, "getInfo">,
    walletRepository: WalletRepository,
): Promise<ResolvedArkInfo> {
    let info: ArkInfo;
    try {
        info = await arkProvider.getInfo();
    } catch (err) {
        if (!isRetryableProviderError(err)) throw err;
        // Retryable: fall back to cache. A malformed stored snapshot throws
        // (terminal) out of loadArkInfoSnapshot rather than being swallowed.
        const snapshot = await loadArkInfoSnapshot(walletRepository);
        if (!snapshot) {
            throw new ProviderUnavailableError(
                "Arkade server info is unavailable and no cached snapshot exists",
                { cause: err },
            );
        }
        return { info: hydrateArkInfo(snapshot), source: "cache", lastOnlineAt: snapshot.savedAt };
    }
    return { info, source: "live" };
}

/**
 * Persist a snapshot of *validated* live server-info. Call this only after
 * wallet construction has accepted the response — network, signer, and (for a
 * full wallet) checkpoint/forfeit parsing — so a terminal live response can
 * never overwrite a good cache before failing. Best-effort: a storage hiccup
 * must not fail an otherwise-online construction.
 */
export async function saveValidatedArkInfoSnapshot(
    repo: WalletRepository,
    info: ArkInfo,
    savedAt: number,
): Promise<void> {
    try {
        await saveArkInfoSnapshot(repo, info, savedAt);
    } catch (err) {
        console.warn("Failed to persist Ark info snapshot", err);
    }
}
