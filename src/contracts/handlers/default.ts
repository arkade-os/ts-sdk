import { hex } from "@scure/base";
import * as bip68 from "bip68";
import { DefaultVtxo } from "../../script/default";
import { RelativeTimelock } from "../../script/tapscript";
import {
    Contract,
    ContractHandler,
    PathContext,
    PathSelection,
} from "../types";

/**
 * Convert RelativeTimelock to BIP68 sequence number.
 */
function timelockToSequence(timelock: RelativeTimelock): number {
    return bip68.encode(
        timelock.type === "blocks"
            ? { blocks: Number(timelock.value) }
            : { seconds: Number(timelock.value) }
    );
}

/**
 * Convert BIP68 sequence number back to RelativeTimelock.
 */
function sequenceToTimelock(sequence: number): RelativeTimelock {
    const decoded = bip68.decode(sequence);
    if ("blocks" in decoded && decoded.blocks !== undefined) {
        return { type: "blocks", value: BigInt(decoded.blocks) };
    }
    if ("seconds" in decoded && decoded.seconds !== undefined) {
        return { type: "seconds", value: BigInt(decoded.seconds) };
    }
    throw new Error(`Invalid BIP68 sequence: ${sequence}`);
}

/**
 * Typed parameters for DefaultVtxo contracts.
 */
export interface DefaultContractParams {
    pubKey: Uint8Array;
    serverPubKey: Uint8Array;
    csvTimelock?: RelativeTimelock;
}

/**
 * Handler for default wallet VTXOs.
 *
 * Default contracts use the standard forfeit + exit tapscript:
 * - forfeit: (Alice + Server) multisig for collaborative spending
 * - exit: (Alice) + CSV timelock for unilateral exit
 */
export const DefaultContractHandler: ContractHandler<
    DefaultContractParams,
    DefaultVtxo.Script
> = {
    type: "default",

    createScript(params: Record<string, string>): DefaultVtxo.Script {
        const typed = this.deserializeParams(params);
        return new DefaultVtxo.Script(typed);
    },

    serializeParams(params: DefaultContractParams): Record<string, string> {
        const result: Record<string, string> = {
            pubKey: hex.encode(params.pubKey),
            serverPubKey: hex.encode(params.serverPubKey),
        };

        if (params.csvTimelock) {
            result.csv = timelockToSequence(params.csvTimelock).toString();
        }

        return result;
    },

    deserializeParams(params: Record<string, string>): DefaultContractParams {
        const result: DefaultContractParams = {
            pubKey: hex.decode(params.pubKey),
            serverPubKey: hex.decode(params.serverPubKey),
        };

        if (params.csv) {
            result.csvTimelock = sequenceToTimelock(Number(params.csv));
        }

        return result;
    },

    selectPath(
        script: DefaultVtxo.Script,
        _contract: Contract,
        context: PathContext
    ): PathSelection | null {
        if (context.collaborative) {
            // Use forfeit path for collaborative spending
            return { leaf: script.forfeit() };
        }

        // Use exit path for unilateral exit
        // Note: sequence is derived from the CSV in the script itself
        return { leaf: script.exit() };
    },

    getSpendablePaths(
        script: DefaultVtxo.Script,
        _contract: Contract,
        context: PathContext
    ): PathSelection[] {
        const paths: PathSelection[] = [];

        if (context.collaborative) {
            // Forfeit path available with server cooperation
            paths.push({ leaf: script.forfeit() });
        }

        // Exit path always available (CSV checked at tx time)
        paths.push({ leaf: script.exit() });

        return paths;
    },
};
