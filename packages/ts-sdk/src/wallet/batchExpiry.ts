import type { Network } from "../networks";
import type { RelativeTimelock } from "../script/tapscript";
import { ServerResponseMismatchError } from "../providers/errors";
import { assertTimelockWithinFloor, isRegtest } from "./timelockPolicy";

/** Wall-clock floor for `batchExpiry` outside regtest. */
export const DEFAULT_MIN_BATCH_EXPIRY_SECONDS = 86_400n;

/** Wall-clock floor for `batchExpiry` on regtest (~10 blocks). */
export const REGTEST_MIN_BATCH_EXPIRY_SECONDS = 6_000n;

/** Bounds applied to a server-supplied `BatchStartedEvent.batchExpiry`. */
export type BatchExpiryPolicy = {
    /** Minimum wall-clock delay in seconds, after normalization. */
    minSeconds: bigint;
    /**
     * Reject block-typed timelocks. Mirrors arkd, which allows a block-typed
     * vtxo tree expiry only on regtest.
     */
    requireSeconds: boolean;
    /** When advertised by the operator, `batchExpiry` must equal it exactly. */
    advertisedVtxoTreeExpiry?: bigint;
};

/**
 * Default policy for a network.
 *
 * Derive it from the locally held {@link Network} — pinned at wallet setup —
 * rather than from a per-round server field, so the permissive regtest branch
 * can't be selected by the operator at event time.
 */
export function defaultBatchExpiryPolicy(network: Network): BatchExpiryPolicy {
    return isRegtest(network)
        ? { minSeconds: REGTEST_MIN_BATCH_EXPIRY_SECONDS, requireSeconds: false }
        : { minSeconds: DEFAULT_MIN_BATCH_EXPIRY_SECONDS, requireSeconds: true };
}

/** Resolve a policy for `network`, applying any caller overrides on top. */
export function resolveBatchExpiryPolicy(
    network: Network,
    overrides?: Partial<BatchExpiryPolicy>,
): BatchExpiryPolicy {
    return { ...defaultBatchExpiryPolicy(network), ...overrides };
}

/**
 * Check a server-supplied batch expiry against `policy` and return the timelock
 * to commit to.
 *
 * The sweep leaf of the shared batch output is derived from this value, so it
 * is never reconstructible from anything else the server sends: validating the
 * tree only proves it is consistent with whatever value was chosen. Callers
 * must encode the returned timelock rather than re-deriving their own.
 *
 * @throws {ServerResponseMismatchError} if the value is out of policy.
 */
export function assertValidBatchExpiry(
    batchExpiry: bigint,
    policy: BatchExpiryPolicy,
): RelativeTimelock {
    if (
        policy.advertisedVtxoTreeExpiry !== undefined &&
        batchExpiry !== policy.advertisedVtxoTreeExpiry
    ) {
        throw new ServerResponseMismatchError(
            `batch expiry rejected: ${batchExpiry} does not match the advertised ` +
                `vtxoTreeExpiry ${policy.advertisedVtxoTreeExpiry}`,
        );
    }

    return assertTimelockWithinFloor(batchExpiry, policy, "batch expiry");
}
