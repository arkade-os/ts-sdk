import type { Network } from "../networks";
import type { RelativeTimelock } from "../script/tapscript";
import { ServerResponseMismatchError } from "../providers/errors";

export const isRegtest = (network: Network): boolean => network.bech32 === "bcrt";

/**
 * Nominal seconds per block, used only to compare a block-typed timelock
 * against a wall-clock floor. Coarse by design: under the default policies
 * block-typed values are only accepted on regtest.
 */
export const NOMINAL_BLOCK_SECONDS = 600n;

/** Floor + type bounds shared by every server-controlled relative timelock. */
export type TimelockFloorPolicy = {
    /** Minimum wall-clock delay in seconds, after normalization. */
    minSeconds: bigint;
    /**
     * Reject block-typed timelocks. Mirrors arkd, which allows block-typed
     * relative locktimes only on regtest.
     */
    requireSeconds: boolean;
};

/**
 * Type a bare wire value the way the protocol does: >= 512 is seconds, below is
 * blocks.
 *
 * Only for values that arrive without a type of their own (e.g. a
 * `BatchStartedEvent.batchExpiry` integer). A timelock decoded from a script
 * carries its own BIP-68 disable-flag-derived type — pass that straight to
 * {@link assertTimelockInPolicy} instead, since a block-typed value there can
 * legitimately exceed 512 and re-deriving would misread it as seconds.
 */
export const toTimelock = (value: bigint): RelativeTimelock => ({
    value,
    type: value >= 512n ? "seconds" : "blocks",
});

export const toSeconds = (t: RelativeTimelock): bigint =>
    t.type === "seconds" ? t.value : t.value * NOMINAL_BLOCK_SECONDS;

/**
 * Check an already-typed server-supplied relative timelock against `policy`.
 *
 * `label` names the value in thrown messages (e.g. `"batch expiry"`,
 * `"checkpoint exit delay"`) and `overrideOption` names the wallet-config
 * option that lowers this particular floor (e.g. `"minBatchExpirySeconds"`), so
 * callers share this one implementation without losing message specificity. A
 * floor rejection quotes the value that would accept the timelock alongside the
 * option name, so acting on the message needs nothing the message did not say.
 *
 * @throws {ServerResponseMismatchError} if the timelock is out of policy.
 */
export function assertTimelockInPolicy(
    timelock: RelativeTimelock,
    policy: TimelockFloorPolicy,
    label: string,
    overrideOption: string,
): RelativeTimelock {
    if (policy.requireSeconds && timelock.type === "blocks") {
        // No override named here on purpose: `requireSeconds` is not settable
        // through the wallet config, so only the floor half of this policy is
        // something a caller can act on.
        throw new ServerResponseMismatchError(
            `${label} rejected: block-typed timelocks are not accepted (got ${timelock.value})`,
        );
    }

    const seconds = toSeconds(timelock);
    if (seconds < policy.minSeconds) {
        throw new ServerResponseMismatchError(
            `${label} rejected: ${timelock.value} ${timelock.type} is below the ` +
                `${policy.minSeconds}s floor; pass ${overrideOption}: ${seconds}n to ` +
                `Wallet.create to lower it`,
        );
    }

    return timelock;
}

/**
 * Type a bare server-supplied timelock value with {@link toTimelock}, then
 * check it against `policy`.
 *
 * @throws {ServerResponseMismatchError} if the value is out of policy.
 */
export function assertTimelockWithinFloor(
    value: bigint,
    policy: TimelockFloorPolicy,
    label: string,
    overrideOption: string,
): RelativeTimelock {
    return assertTimelockInPolicy(toTimelock(value), policy, label, overrideOption);
}
