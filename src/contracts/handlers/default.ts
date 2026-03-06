import { hex } from "@scure/base";
import { DefaultVtxo } from "../../script/default";
import { RelativeTimelock } from "../../script/tapscript";
import {
    Contract,
    ContractHandler,
    PathContext,
    PathSelection,
} from "../types";
import {
    isCsvSpendable,
    sequenceToTimelock,
    timelockToSequence,
} from "./helpers";

/**
 * Typed parameters for DefaultVtxo contracts.
 */
export interface DefaultContractParams {
    pubKey: Uint8Array;
    serverPubKey: Uint8Array;
    csvTimelock: RelativeTimelock;
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
        return {
            pubKey: hex.encode(params.pubKey),
            serverPubKey: hex.encode(params.serverPubKey),
            csvTimelock: timelockToSequence(params.csvTimelock).toString(),
        };
    },

    deserializeParams(params: Record<string, string>): DefaultContractParams {
        const csvTimelock = params.csvTimelock
            ? sequenceToTimelock(Number(params.csvTimelock))
            : DefaultVtxo.Script.DEFAULT_TIMELOCK;
        return {
            pubKey: hex.decode(params.pubKey),
            serverPubKey: hex.decode(params.serverPubKey),
            csvTimelock,
        };
    },

    selectPath(
        script: DefaultVtxo.Script,
        contract: Contract,
        context: PathContext
    ): PathSelection | null {
        if (context.collaborative) {
            // Use forfeit path for collaborative spending
            return { leaf: script.forfeit() };
        }

        // Use exit path for unilateral exit (only if CSV is satisfied)
        const sequence = contract.params.csvTimelock
            ? Number(contract.params.csvTimelock)
            : undefined;
        if (!isCsvSpendable(context, sequence)) {
            return null;
        }
        return {
            leaf: script.exit(),
            sequence,
        };
    },

    getAllSpendingPaths(
        script: DefaultVtxo.Script,
        contract: Contract,
        context: PathContext
    ): PathSelection[] {
        const paths: PathSelection[] = [];

        // Forfeit path available with server cooperation
        if (context.collaborative) {
            paths.push({ leaf: script.forfeit() });
        }

        // Exit path always possible (CSV checked at tx time)
        const exitPath: PathSelection = { leaf: script.exit() };
        if (contract.params.csvTimelock) {
            exitPath.sequence = Number(contract.params.csvTimelock);
        }
        paths.push(exitPath);

        return paths;
    },

    getSpendablePaths(
        script: DefaultVtxo.Script,
        contract: Contract,
        context: PathContext
    ): PathSelection[] {
        const paths: PathSelection[] = [];

        if (context.collaborative) {
            paths.push({ leaf: script.forfeit() });
        }

        const exitSequence = contract.params.csvTimelock
            ? Number(contract.params.csvTimelock)
            : undefined;

        if (isCsvSpendable(context, exitSequence)) {
            const exitPath: PathSelection = { leaf: script.exit() };
            if (exitSequence !== undefined) {
                exitPath.sequence = exitSequence;
            }
            paths.push(exitPath);
        }

        return paths;
    },
};
