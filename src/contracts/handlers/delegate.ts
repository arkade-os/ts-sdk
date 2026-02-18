import { hex } from "@scure/base";
import { DelegateVtxo } from "../../script/delegate";
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
 * Typed parameters for DelegateVtxo contracts.
 */
export interface DelegateContractParams {
    pubKey: Uint8Array;
    serverPubKey: Uint8Array;
    delegatePubKey: Uint8Array;
    csvTimelock: RelativeTimelock;
}

/**
 * Handler for delegate wallet VTXOs.
 *
 * Delegate contracts extend the default tapscript with an additional delegate path:
 * - forfeit: (Alice + Server) multisig for collaborative spending
 * - exit: (Alice) + CSV timelock for unilateral exit
 * - delegate: (Alice + Delegate + Server) multisig for delegated renewal
 */
export const DelegateContractHandler: ContractHandler<
    DelegateContractParams,
    DelegateVtxo.Script
> = {
    type: "delegate",

    createScript(params: Record<string, string>): DelegateVtxo.Script {
        const typed = this.deserializeParams(params);
        return new DelegateVtxo.Script(typed);
    },

    serializeParams(params: DelegateContractParams): Record<string, string> {
        return {
            pubKey: hex.encode(params.pubKey),
            serverPubKey: hex.encode(params.serverPubKey),
            delegatePubKey: hex.encode(params.delegatePubKey),
            csvTimelock: timelockToSequence(params.csvTimelock).toString(),
        };
    },

    deserializeParams(params: Record<string, string>): DelegateContractParams {
        const csvTimelock = params.csvTimelock
            ? sequenceToTimelock(Number(params.csvTimelock))
            : DefaultVtxo.Script.DEFAULT_TIMELOCK;
        return {
            pubKey: hex.decode(params.pubKey),
            serverPubKey: hex.decode(params.serverPubKey),
            delegatePubKey: hex.decode(params.delegatePubKey),
            csvTimelock,
        };
    },

    selectPath(
        script: DelegateVtxo.Script,
        contract: Contract,
        context: PathContext
    ): PathSelection | null {
        if (context.collaborative) {
            return { leaf: script.forfeit() };
        }

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
        script: DelegateVtxo.Script,
        contract: Contract,
        context: PathContext
    ): PathSelection[] {
        const paths: PathSelection[] = [];

        if (context.collaborative) {
            paths.push({ leaf: script.forfeit() });
        }

        const exitPath: PathSelection = { leaf: script.exit() };
        if (contract.params.csvTimelock) {
            exitPath.sequence = Number(contract.params.csvTimelock);
        }
        paths.push(exitPath);

        // Delegate path (Alice + Delegate + Server) — collaborative only
        if (context.collaborative) {
            paths.push({ leaf: script.delegate() });
        }

        return paths;
    },

    getSpendablePaths(
        script: DelegateVtxo.Script,
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

        // Delegate path is collaborative (requires all 3 parties)
        if (context.collaborative) {
            paths.push({ leaf: script.delegate() });
        }

        return paths;
    },
};
