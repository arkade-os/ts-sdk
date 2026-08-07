import type { Network } from "../networks";
import type { RelativeTimelock } from "../script/tapscript";
import { ServerResponseMismatchError } from "../providers/errors";

/**
 * Nominal seconds per block, used only to compare a block-typed timelock
 * against a wall-clock floor. Coarse by design: under the default policies
 * block-typed values are only accepted on regtest.
 */
const NOMINAL_BLOCK_SECONDS = 600n;

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

const isRegtest = (network: Network): boolean => network.bech32 === "bcrt";

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

/** BIP-68 reads values >= 512 as seconds, below as blocks. */
const toTimelock = (value: bigint): RelativeTimelock => ({
    value,
    type: value >= 512n ? "seconds" : "blocks",
});

const toSeconds = (t: RelativeTimelock): bigint =>
    t.type === "seconds" ? t.value : t.value * NOMINAL_BLOCK_SECONDS;

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
    const timelock = toTimelock(batchExpiry);

    if (policy.advertisedVtxoTreeExpiry !== undefined) {
        if (batchExpiry !== policy.advertisedVtxoTreeExpiry) {
            throw new ServerResponseMismatchError(
                `batch expiry rejected: ${batchExpiry} does not match the advertised ` +
                    `vtxoTreeExpiry ${policy.advertisedVtxoTreeExpiry}`,
            );
        }
    }

    if (policy.requireSeconds && timelock.type === "blocks") {
        throw new ServerResponseMismatchError(
            `batch expiry rejected: block-typed timelocks are not accepted (got ${batchExpiry})`,
        );
    }

    const seconds = toSeconds(timelock);
    if (seconds < policy.minSeconds) {
        throw new ServerResponseMismatchError(
            `batch expiry rejected: ${timelock.value} ${timelock.type} is below the ` +
                `${policy.minSeconds}s floor`,
        );
    }

    return timelock;
}
