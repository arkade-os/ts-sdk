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

/** BIP-68 reads values >= 512 as seconds, below as blocks. */
export const toTimelock = (value: bigint): RelativeTimelock => ({
    value,
    type: value >= 512n ? "seconds" : "blocks",
});

export const toSeconds = (t: RelativeTimelock): bigint =>
    t.type === "seconds" ? t.value : t.value * NOMINAL_BLOCK_SECONDS;

/**
 * Check a server-supplied relative-timelock value against `policy`.
 *
 * `label` names the value in thrown messages (e.g. `"batch expiry"`,
 * `"checkpoint exit delay"`) so callers share this one implementation without
 * losing message specificity.
 *
 * @throws {ServerResponseMismatchError} if the value is out of policy.
 */
export function assertTimelockWithinFloor(
    value: bigint,
    policy: TimelockFloorPolicy,
    label: string,
): RelativeTimelock {
    const timelock = toTimelock(value);

    if (policy.requireSeconds && timelock.type === "blocks") {
        throw new ServerResponseMismatchError(
            `${label} rejected: block-typed timelocks are not accepted (got ${value})`,
        );
    }

    const seconds = toSeconds(timelock);
    if (seconds < policy.minSeconds) {
        throw new ServerResponseMismatchError(
            `${label} rejected: ${timelock.value} ${timelock.type} is below the ` +
                `${policy.minSeconds}s floor`,
        );
    }

    return timelock;
}
