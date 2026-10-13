import type { Network } from "../networks";
import type { RelativeTimelock } from "../script/tapscript";
import { ServerResponseMismatchError } from "../providers/errors";

export const isRegtest = (network: Network): boolean => network.bech32 === "bcrt";

/**
 * Nominal seconds per block, only for comparing a block-typed timelock against a wall-clock
 * floor. Coarse by design: default policies accept block-typed values only on regtest.
 */
export const NOMINAL_BLOCK_SECONDS = 600n;

/** Floor + type bounds shared by every server-controlled relative timelock. */
export type TimelockFloorPolicy = {
    /** Minimum wall-clock delay in seconds, after normalization. */
    minSeconds: bigint;
    /** Reject block-typed timelocks (arkd allows them only on regtest). */
    requireSeconds: boolean;
};

/**
 * Type a bare wire value the protocol way: >= 512 is seconds, below is blocks. Only for untyped
 * values (e.g. `BatchStartedEvent.batchExpiry`); a script-decoded timelock carries its BIP-68
 * type and can be block-typed above 512, so pass it to {@link assertTimelockInPolicy} directly.
 */
export const toTimelock = (value: bigint): RelativeTimelock => ({
    value,
    type: value >= 512n ? "seconds" : "blocks",
});

export const toSeconds = (t: RelativeTimelock): bigint =>
    t.type === "seconds" ? t.value : t.value * NOMINAL_BLOCK_SECONDS;

/**
 * Check an already-typed server-supplied relative timelock against `policy`. `label` names the
 * value in messages; `overrideOption` names the wallet-config option that lowers this floor, and
 * a floor rejection quotes the value that would pass.
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
        // No override named: `requireSeconds` is not settable through wallet config.
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
 * {@link toTimelock} then {@link assertTimelockInPolicy}.
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
