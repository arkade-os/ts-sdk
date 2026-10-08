import { hex } from "@scure/base";
import { Bytes, equalBytes } from "@scure/btc-signer/utils.js";
import type { Network, NetworkName } from "../networks";
import { CSVMultisigTapscript } from "../script/tapscript";
import { ServerResponseMismatchError } from "../providers/errors";
import { assertTimelockInPolicy, isRegtest } from "./timelockPolicy";

/** Wall-clock floor for the checkpoint exit delay outside regtest. Matches arkd's own default. */
export const DEFAULT_MIN_CHECKPOINT_EXIT_DELAY_SECONDS = 86_400n;

/**
 * Wall-clock floor for the checkpoint exit delay on regtest (~2 blocks nominal).
 *
 * Deliberately lower than {@link REGTEST_MIN_BATCH_EXPIRY_SECONDS "../wallet/batchExpiry"}: sized
 * to clear a 5-block `ARKD_CHECKPOINT_EXIT_DELAY` while still rejecting a 1-block attack. Could be
 * tightened once no external regtest deployment is known to rely on the lower bound.
 */
export const REGTEST_MIN_CHECKPOINT_EXIT_DELAY_SECONDS = 1_200n;

/**
 * Wall-clock floor for the checkpoint exit delay on mutinynet: exactly the hosted Arkade Service's
 * advertised 4096s (8 * 512) CSV, sized for ~30s blocks.
 */
export const MUTINYNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS = 4_096n;

/**
 * Wall-clock floor for the checkpoint exit delay on signet: the hosted Arkade Service's advertised
 * 86016s (168 * 512), i.e. 24h rounded down to BIP-68's 512s granularity (86400 is not a multiple
 * of 512, so it cannot be encoded). That is 384s under the default floor.
 */
export const SIGNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS = 86_016n;

/**
 * Floors for networks whose hosted Arkade Service advertises a delay below the default. Each is
 * that operator's own value, so nothing lower is accepted; `bitcoin`/`testnet` are deliberately
 * absent and keep the generic floor.
 */
const HOSTED_MIN_CHECKPOINT_EXIT_DELAY_SECONDS: Partial<Record<NetworkName, bigint>> = {
    signet: SIGNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
    mutinynet: MUTINYNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
};

/** Bounds applied to a server-supplied `ArkadeInfo.checkpointTapscript`. */
export type CheckpointExitDelayPolicy = {
    /** Minimum wall-clock delay in seconds, after normalization. */
    minSeconds: bigint;
    /** Reject block-typed timelocks. Mirrors arkd, which allows them only on regtest. */
    requireSeconds: boolean;
    /**
     * When set, the script's embedded pubkey must equal this x-only key.
     *
     * arkd always builds the checkpoint tapscript from its own `forfeitPubkey`, so pass the one the
     * caller already trusts: pinned wallet state where it exists, otherwise the same `ArkadeInfo`
     * response's `forfeitPubkey` as a self-consistency check.
     */
    advertisedForfeitPubkey?: Bytes;
};

/**
 * Default policy for a network. Derived from the locally pinned {@link Network}, not server data,
 * so the operator cannot select the permissive regtest branch.
 */
export function defaultCheckpointExitDelayPolicy(network: Network): CheckpointExitDelayPolicy {
    if (isRegtest(network)) {
        return { minSeconds: REGTEST_MIN_CHECKPOINT_EXIT_DELAY_SECONDS, requireSeconds: false };
    }
    // A hand-built `Network` has no name: an unrecognized network must not get a relaxed floor.
    const hosted = network.name
        ? HOSTED_MIN_CHECKPOINT_EXIT_DELAY_SECONDS[network.name]
        : undefined;
    // Hosted networks advertise seconds-typed delays, so block-typed stays regtest-only.
    return {
        minSeconds: hosted ?? DEFAULT_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,
        requireSeconds: true,
    };
}

/** Resolve a policy for `network`, applying any caller overrides on top. */
export function resolveCheckpointExitDelayPolicy(
    network: Network,
    overrides?: Partial<CheckpointExitDelayPolicy>,
): CheckpointExitDelayPolicy {
    return { ...defaultCheckpointExitDelayPolicy(network), ...overrides };
}

/**
 * Decode and validate a server-supplied `checkpointTapscript` against `policy`.
 *
 * Every offchain send/claim builds its checkpoint outputs' server-claim leaf from this script, so
 * a sub-floor or wrong-pubkey value lets the operator sweep an in-flight checkpoint before it
 * settles. This is the sole gate: callers must use the returned script, not decode their own.
 *
 * @throws {ServerResponseMismatchError} if the script fails to decode, its
 *   timelock is out of policy, or its pubkey does not match
 *   `policy.advertisedForfeitPubkey` (when set).
 */
export function assertValidServerUnrollScript(
    checkpointTapscript: string,
    policy: CheckpointExitDelayPolicy,
): CSVMultisigTapscript.Type {
    let script: CSVMultisigTapscript.Type;
    try {
        script = CSVMultisigTapscript.decode(hex.decode(checkpointTapscript));
    } catch (e) {
        throw new ServerResponseMismatchError(
            `checkpoint exit delay rejected: invalid checkpointTapscript from server ` +
                `(${e instanceof Error ? e.message : String(e)})`,
        );
    }

    if (policy.advertisedForfeitPubkey !== undefined) {
        const { pubkeys } = script.params;
        // arkd encodes exactly one key; reported apart from a wrong single key for debugging.
        if (pubkeys.length !== 1) {
            throw new ServerResponseMismatchError(
                `checkpoint exit delay rejected: checkpointTapscript must commit to exactly ` +
                    `one pubkey, got ${pubkeys.length} ` +
                    `[${pubkeys.map(hex.encode).join(", ")}]`,
            );
        }
        if (!equalBytes(pubkeys[0], policy.advertisedForfeitPubkey)) {
            throw new ServerResponseMismatchError(
                `checkpoint exit delay rejected: checkpointTapscript pubkey ` +
                    `${hex.encode(pubkeys[0])} does not match the advertised forfeitPubkey ` +
                    `${hex.encode(policy.advertisedForfeitPubkey)}`,
            );
        }
    }

    // Use the type the script encodes (BIP-68 type flag), not the magnitude: a block-typed delay
    // above 511 blocks is legal and would otherwise be misread as seconds.
    assertTimelockInPolicy(
        script.params.timelock,
        policy,
        "checkpoint exit delay",
        "minCheckpointExitDelaySeconds",
    );

    return script;
}
