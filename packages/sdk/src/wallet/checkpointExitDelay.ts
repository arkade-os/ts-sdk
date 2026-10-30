import { hex } from "@scure/base";
import { Bytes, equalBytes } from "@scure/btc-signer/utils.js";
import type { Network } from "../networks";
import { CSVMultisigTapscript } from "../script/tapscript";
import { ServerResponseMismatchError } from "../providers/errors";
import { assertTimelockInPolicy, isRegtest } from "./timelockPolicy";

/**
 * Decode and validate a server-supplied `checkpointTapscript`.
 *
 * Every offchain send/claim builds its checkpoint outputs' server-claim leaf from this script, so
 * a sub-floor or wrong-pubkey value lets the operator sweep an in-flight checkpoint before it
 * settles. This is the sole gate: callers must use the returned script, not decode their own.
 *
 * @throws {ServerResponseMismatchError} if the script fails to decode, its
 *   timelock is out of policy, or its pubkey does not match
 *   `advertisedForfeitPubkey` (when set).
 */
export function assertValidServerUnrollScript(
    checkpointTapscript: string,
    network: Network,
    advertisedForfeitPubkey?: Bytes,
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

    if (advertisedForfeitPubkey !== undefined) {
        const { pubkeys } = script.params;
        if (pubkeys.length !== 1) {
            throw new ServerResponseMismatchError(
                `checkpoint exit delay rejected: checkpointTapscript must commit to exactly ` +
                    `one pubkey, got ${pubkeys.length} ` +
                    `[${pubkeys.map(hex.encode).join(", ")}]`,
            );
        }
        if (!equalBytes(pubkeys[0], advertisedForfeitPubkey)) {
            throw new ServerResponseMismatchError(
                `checkpoint exit delay rejected: checkpointTapscript pubkey ` +
                    `${hex.encode(pubkeys[0])} does not match the advertised forfeitPubkey ` +
                    `${hex.encode(advertisedForfeitPubkey)}`,
            );
        }
    }

    // Use the type the script encodes (BIP-68 type flag), not the magnitude: a block-typed delay
    // above 511 blocks is legal and would otherwise be misread as seconds.
    assertTimelockInPolicy(
        script.params.timelock,
        { minSeconds: 512n, requireSeconds: !isRegtest(network) },
        "checkpoint exit delay",
    );

    return script;
}
