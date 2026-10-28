import { hex } from "@scure/base";
import { Bytes, equalBytes } from "@scure/btc-signer/utils.js";
import type { Network } from "../networks";
import { CSVMultisigTapscript } from "../script/tapscript";
import { ServerResponseMismatchError } from "../providers/errors";
import { assertTimelockInPolicy, isRegtest } from "./timelockPolicy";

/**
 * Decode a server-supplied `checkpointTapscript`: 512s floor (the smallest seconds-typed CSV),
 * block-typed delays on regtest only, pubkey equal to `advertisedForfeitPubkey` when given.
 * `network` is the caller's pinned one, never the response's, so an operator cannot name
 * `regtest` to unlock block-typed delays.
 *
 * @throws {ServerResponseMismatchError}
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
