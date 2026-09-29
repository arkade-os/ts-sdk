/**
 * The serializable projection of a monitored RFQ swap.
 *
 * {@link RfqSwap} holds `Uint8Array`s and a `VHTLC.ScriptV2` instance, and IndexedDB's structured
 * clone strips prototypes, so a consumer stores THIS and rebuilds the live record at boot.
 *
 * **The covenant is not stored here.** Every RFQ lockup registers a contract row (keyed by the
 * script its params derive) before it can be funded; a second copy here would be two sources for
 * one covenant. {@link rebuildRfqSwap} takes the params from its caller instead
 * (`lockupContractParams`, or the consumer's own `serializeParams(...)` copy).
 *
 * **No record written here carries a private key.** The descriptor and the per-swap salt P derives
 * from are public; `preimageHex` appears only when the SDK says P cannot be re-derived at all.
 */
import { ArkAddress, VHTLCV2ContractHandler, type VHTLC } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import type { LightningReceiveSwap, LightningSendSwap, OnchainSendSwap } from "./swapManager";
// Not from `swapManager`: the manager persists through this file, so that edge would be a cycle.
import { isRfqSwapTerminal, type RfqSwapState } from "./rfqSwapState";
import { rfqCorridorHandlers } from "./rfqCorridor";
import "./rfqCorridors";

/**
 * The swap kinds this projection covers — all three the manager monitors. `onchain_send`'s L1 keys
 * ride in its profile, since no contract row or `OnchainHtlc` field can give them back.
 */
export type PersistableRfqSwap = LightningSendSwap | LightningReceiveSwap | OnchainSendSwap;

/**
 * The serialized covenant parameters a rebuild is given: `VHTLCV2ContractHandler`'s own wire shape,
 * exactly what a lockup's contract row stores under `params`.
 */
export type LockupParams = Record<string, string>;

/**
 * How long a retired swap's record is kept, in SECONDS (the unit of `RfqSwap.updatedAt`).
 * Terminal records are history the wallet's own tx history cannot reconstruct.
 */
/** @deprecated `accept()` writes the record; read it with `client.swaps()`. Moved off the package root to `@arkade-os/swap/protocol`. */
export const RFQ_SWAP_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** The immutable request-time half, and only what EVERY corridor has. Hex for
 * everything binary, so the record is plain JSON and survives any
 * structured-clone backend unchanged. */
export interface RfqSwapOrigin {
    /**
     * Which corridor this is. Resolves the handler that owns {@link profile};
     * see `rfqCorridor.ts`.
     *
     * The manager's own union, not an open string: a kind it does not branch on would persist and
     * rebuild here and then never be driven.
     */
    kind: PersistableRfqSwap["kind"];

    /**
     * The Arkade address that was funded: the handle {@link lockupContractParams} looks the row up
     * by, and, being taken from the entry point, the check that supplied params are THIS swap's.
     */
    lockupAddress: string;

    /**
     * The corridor's own half, as plain JSON — written by the caller from the
     * request result, kept current by the handler's `project`.
     *
     * Opaque here, so a new corridor ships without touching this file or the stores. Carries the
     * corridor's keys (`signer`, and `hashlock` with the `sha256(P)` the covenant cannot give
     * back); write them with `rfqSecretsProfile`. Not a consumer scratchpad: every write merges
     * `handler.project(swap)` over it.
     */
    profile: Record<string, unknown>;

    /** Consumer display metadata. The rebuild ignores it — `RfqSwapCommon`
     * carries no amount of its own. */
    amount?: number;

    /**
     * The ark transaction that funded {@link lockupAddress}. Origin, not manager state: only the
     * caller that broadcast it knows it, so it is written once and no `project` emits it.
     */
    fundingTxid?: string;
}

/** The stored record: the origin plus the manager's mutable state. */
export interface RfqSwapRecord extends RfqSwapOrigin {
    rfqId: string;
    state: RfqSwapState;
    createdAt: number;
    updatedAt: number;
    refundTxid?: string;
    /** See `RfqSwapCommon.lockupSpendTxids`. */
    lockupSpendTxids?: string[];
    /** See `RfqSwapCommon.settlementPreimageHex`. */
    settlementPreimageHex?: string;
    failure?: string;
    /** Last local receive-claim error while the swap is still retryable. */
    claimFailure?: string;
    blockedReason?: string;
}

/**
 * The txid fields under their legacy on-disk names; see {@link normalizeRfqSwapRecord}. Kept off
 * {@link RfqSwapRecord} because nothing writes them any more.
 */
interface LegacyRfqSwapTxids {
    fundingArkTxid?: string;
    refundArkTxid?: string;
    lockupSpendArkTxids?: string[];
}

/** The receive corridor's profile with `claimArkTxid` read as `claimTxid`. */
function renameLegacyClaimTxid(profile: Record<string, unknown>): Record<string, unknown> {
    const { claimArkTxid, ...rest } = profile;
    return { ...rest, claimTxid: rest.claimTxid ?? claimArkTxid };
}

/**
 * A stored record read under the current field names.
 *
 * `0.0.8`/`0.0.9` wrote `fundingArkTxid`, `refundArkTxid`, `lockupSpendArkTxids` and
 * `profile.claimArkTxid`, which current code would read as `undefined`. Every function here that
 * takes a record calls this, so no boot-time migration is needed and the next write drops the old
 * keys. Sharpest effect: a partly claimed receive leg keeps its `claimTxid`, so the value gate
 * stays disarmed over a public preimage.
 */
export function normalizeRfqSwapRecord(record: RfqSwapRecord): RfqSwapRecord {
    const { fundingArkTxid, refundArkTxid, lockupSpendArkTxids, ...rest } =
        record as RfqSwapRecord & LegacyRfqSwapTxids;
    // Only the receive corridor's profile ever carried the old name.
    const legacyClaim =
        record.kind === "lightning_receive" && record.profile.claimArkTxid !== undefined;
    if (!fundingArkTxid && !refundArkTxid && !lockupSpendArkTxids && !legacyClaim) return record;

    const fundingTxid = rest.fundingTxid ?? fundingArkTxid;
    const refundTxid = rest.refundTxid ?? refundArkTxid;
    const lockupSpendTxids = rest.lockupSpendTxids ?? lockupSpendArkTxids;
    return {
        ...rest,
        ...(fundingTxid ? { fundingTxid } : {}),
        ...(refundTxid ? { refundTxid } : {}),
        ...(lockupSpendTxids?.length ? { lockupSpendTxids } : {}),
        ...(legacyClaim ? { profile: renameLegacyClaimTxid(record.profile) } : {}),
    };
}

/** The optional mutable fields, each written only when set — in both directions. */
const mutableFields = (from: PersistableRfqSwap | RfqSwapRecord) => ({
    ...(from.refundTxid ? { refundTxid: from.refundTxid } : {}),
    ...(from.lockupSpendTxids?.length ? { lockupSpendTxids: [...from.lockupSpendTxids] } : {}),
    ...(from.settlementPreimageHex ? { settlementPreimageHex: from.settlementPreimageHex } : {}),
    ...(from.failure ? { failure: from.failure } : {}),
    ...(from.claimFailure ? { claimFailure: from.claimFailure } : {}),
    ...(from.blockedReason ? { blockedReason: from.blockedReason } : {}),
});

/**
 * The manager's mutable half, projected off a live record.
 *
 * Only `RfqSwapCommon` fields: a per-kind field lifted here would be written and restored by
 * nobody, since `rebuildRfqSwap` builds the common half from `RfqSwapCommon` alone. Per-corridor
 * state (e.g. `claimTxid`) goes through the handler's `project`.
 */
const managerState = (swap: PersistableRfqSwap) => ({
    rfqId: swap.rfqId,
    state: swap.state,
    createdAt: swap.createdAt,
    updatedAt: swap.updatedAt,
    ...mutableFields(swap),
});

/**
 * The origin and the live swap must be halves of one swap.
 *
 * Exported so `RfqSwapManager.addSwap` can check at admission, before funding is broadcast.
 * Neither mismatch is loud: a wrong `kind` runs the wrong handler's `project`, e.g. writing
 * `expectedAmount: undefined` over the caller's value and deleting the gate; a wrong address makes
 * {@link rebuildRfqSwap} watch a covenant this swap never monitored.
 */
export function assertSameSwap(origin: RfqSwapOrigin, swap: PersistableRfqSwap): void {
    if (origin.kind !== swap.kind) {
        throw new Error(
            `rfq swap record is a ${origin.kind} origin paired with a ${swap.kind} swap`,
        );
    }
    const funded = hex.encode(ArkAddress.decode(origin.lockupAddress).pkScript);
    const watched = hex.encode(swap.lockupPkScript);
    if (funded !== watched) {
        throw new Error(
            `rfq swap record's lockup address holds ${funded}, but the swap watches ${watched} — ` +
                `these are not the same swap`,
        );
    }
}

/** First write, at the moment the caller hands the swap to the manager. */
export function createRfqSwapRecord(
    origin: RfqSwapOrigin,
    swap: PersistableRfqSwap,
): RfqSwapRecord {
    assertSameSwap(origin, swap);
    const handler = rfqCorridorHandlers.getOrThrow(origin.kind);
    return {
        ...origin,
        ...managerState(swap),
        profile: { ...origin.profile, ...handler.project(swap) },
    };
}

/**
 * Every later write. The origin half is carried through untouched.
 *
 * The mutable half is REPLACED, not merged: `managerState` omits keys the live swap no longer
 * carries, and the manager deliberately clears `blockedReason` and `claimFailure`, whose stale
 * values would read as live refusal or retry state.
 */
export function updateRfqSwapRecord(
    record: RfqSwapRecord,
    swap: PersistableRfqSwap,
): RfqSwapRecord {
    // Re-checked on every write: record and swap are looked up separately, and a mixed pair is how
    // a good record acquires another swap's state.
    assertSameSwap(record, swap);
    const stored = normalizeRfqSwapRecord(record);
    const {
        refundTxid: _refundTxid,
        lockupSpendTxids: _lockupSpendTxids,
        settlementPreimageHex: _settlementPreimageHex,
        failure: _failure,
        claimFailure: _claimFailure,
        blockedReason: _blockedReason,
        ...origin
    } = stored;
    const handler = rfqCorridorHandlers.getOrThrow(stored.kind);
    // The profile MERGES: `project` returns only what the manager can change; the rest has no
    // other source.
    return {
        ...origin,
        ...managerState(swap),
        profile: { ...stored.profile, ...handler.project(swap) },
    };
}

/**
 * The immutable half of a stored record, on its own.
 *
 * Passing a `record` where an {@link RfqSwapOrigin} is wanted type-checks but is a bug: spread into
 * {@link createRfqSwapRecord} it carries stale `failure`/`blockedReason`/`claimFailure`/
 * `refundTxid` that `managerState` cannot clear. `restoreFromRepository` keeps this per record so
 * a later write can recreate a record the store lost.
 */
export function rfqSwapOriginOf(record: RfqSwapRecord): RfqSwapOrigin {
    const stored = normalizeRfqSwapRecord(record);
    return {
        kind: stored.kind,
        lockupAddress: stored.lockupAddress,
        profile: { ...stored.profile },
        ...(stored.amount !== undefined ? { amount: stored.amount } : {}),
        ...(stored.fundingTxid ? { fundingTxid: stored.fundingTxid } : {}),
    };
}

/**
 * The covenant a record is locked to, from parameters supplied by the caller.
 *
 * Params and `lockupAddress` reach the record independently, so requiring them to agree stops the
 * wrong row (or one a backend read back short a key) from yielding a swap watching an unfunded
 * covenant.
 */
function lockupScript(
    params: LockupParams,
    lockupAddress: string,
): InstanceType<typeof VHTLC.ScriptV2> {
    const script = VHTLCV2ContractHandler.createScript(params);
    const funded = ArkAddress.decode(lockupAddress).pkScript;
    if (hex.encode(funded) !== hex.encode(script.pkScript)) {
        throw new Error(
            `rfq swap covenant params derive ${hex.encode(script.pkScript)}, but the record's ` +
                `lockup address holds ${hex.encode(funded)} — these params are not this swap's`,
        );
    }
    return script;
}

/**
 * Rebuild the live record, purely and synchronously, for {@link RfqSwapManager.start}. `params`
 * (from {@link lockupContractParams} or a consumer-kept copy) are checked against the funded
 * address.
 */
export function rebuildRfqSwap(record: RfqSwapRecord, params: LockupParams): PersistableRfqSwap {
    const stored = normalizeRfqSwapRecord(record);
    const script = lockupScript(params, stored.lockupAddress);

    const common = {
        rfqId: stored.rfqId,
        state: stored.state,
        lockupPkScript: script.pkScript,
        lockup: { script, address: stored.lockupAddress },
        // From the covenant, which binds it: the record's own copy would be a
        // second source for the deadline the refund is gated on.
        refundLocktime: Number(script.options.refundLocktime),
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        ...mutableFields(stored),
    };

    // The kind's handler supplies everything leg-specific (`paymentHash` included); an unregistered
    // kind throws rather than restoring a swap nothing can drive.
    const handler = rfqCorridorHandlers.getOrThrow(stored.kind);
    return {
        ...common,
        kind: stored.kind,
        ...handler.hydrate(stored.profile, { lockup: script }),
    } as PersistableRfqSwap;
}

/**
 * Whether a retired swap's record should be kept.
 *
 * `needs_counterparty` is not terminal and is never dropped: the money is still at the lockup and
 * the refusal is re-checked every pass.
 *
 * @param now Current time in **unix seconds**, the unit of `RfqSwap.updatedAt`. Pass
 * `Math.floor(Date.now() / 1000)`, never `Date.now()`: milliseconds against a seconds window would
 * retire every terminal record after ~43 minutes.
 */
export function shouldRetainRfqSwap(record: RfqSwapRecord, now: number): boolean {
    if (!isRfqSwapTerminal(record.state)) return true;
    return now - record.updatedAt < RFQ_SWAP_RETENTION_SECONDS;
}
