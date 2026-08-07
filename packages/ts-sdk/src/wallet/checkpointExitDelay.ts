import { hex } from "@scure/base";
import { Bytes, equalBytes } from "@scure/btc-signer/utils.js";
import type { Network } from "../networks";
import { CSVMultisigTapscript } from "../script/tapscript";
import { ServerResponseMismatchError } from "../providers/errors";
import { assertTimelockInPolicy, isRegtest } from "./timelockPolicy";

/** Wall-clock floor for the checkpoint exit delay outside regtest. Matches arkd's own default. */
export const DEFAULT_MIN_CHECKPOINT_EXIT_DELAY_SECONDS = 86_400n;

/**
 * Wall-clock floor for the checkpoint exit delay on regtest (~2 blocks nominal).
 *
 * Deliberately lower than {@link REGTEST_MIN_BATCH_EXPIRY_SECONDS "../wallet/batchExpiry"} — this
 * repo's own regtest envs run `ARKD_CHECKPOINT_EXIT_DELAY` as low as 5 blocks
 * (`packages/boltz-swap/.env.regtest`), so the floor must clear that while still rejecting a
 * 1-block attack.
 */
export const REGTEST_MIN_CHECKPOINT_EXIT_DELAY_SECONDS = 1_200n;

/** Bounds applied to a server-supplied `ArkInfo.checkpointTapscript`. */
export type CheckpointExitDelayPolicy = {
    /** Minimum wall-clock delay in seconds, after normalization. */
    minSeconds: bigint;
    /**
     * Reject block-typed timelocks. Mirrors arkd, which allows a block-typed
     * checkpoint exit delay only on regtest.
     */
    requireSeconds: boolean;
    /**
     * When set, the script's embedded pubkey must equal this x-only key.
     *
     * arkd always builds the checkpoint tapscript from its own `forfeitPubkey`
     * (`internal/core/application/service.go`), so this should be the
     * `forfeitPubkey` the caller already trusts — pinned wallet state where one
     * exists, otherwise the same `ArkInfo` response's own `forfeitPubkey` field
     * as a self-consistency check.
     */
    advertisedForfeitPubkey?: Bytes;
};

/**
 * Default policy for a network.
 *
 * Derive it from the locally held {@link Network} — pinned at wallet setup —
 * rather than from server data, so the permissive regtest branch can't be
 * selected by the operator.
 */
export function defaultCheckpointExitDelayPolicy(network: Network): CheckpointExitDelayPolicy {
    return isRegtest(network)
        ? { minSeconds: REGTEST_MIN_CHECKPOINT_EXIT_DELAY_SECONDS, requireSeconds: false }
        : { minSeconds: DEFAULT_MIN_CHECKPOINT_EXIT_DELAY_SECONDS, requireSeconds: true };
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
 * Every offchain send/claim builds its checkpoint outputs' server-claim leaf
 * straight from this script — undecodable, sub-floor or wrong-pubkey values
 * let the operator sweep an in-flight checkpoint before it settles. This is
 * the sole gate: callers must use the returned script rather than decoding
 * their own copy.
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
        // arkd encodes exactly one key here, so anything else is a mismatch —
        // reported separately from a wrong single key so the two are
        // distinguishable when debugging a rejected server.
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

    // Use the type the script itself encodes (BIP-68 disable flag) rather than
    // re-deriving it from the magnitude: a block-typed checkpoint delay above
    // 511 blocks is legal and would otherwise be misread as seconds.
    assertTimelockInPolicy(script.params.timelock, policy, "checkpoint exit delay");

    return script;
}
