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
import {
    normalizeToDescriptor,
    extractPubKey,
} from "../../identity/descriptor";

/**
 * Typed parameters for DefaultVtxo contracts.
 *
 * pubKey and serverPubKey are stored as descriptors (tr(...) format).
 * For backwards compatibility, hex pubkeys are auto-normalized to tr(pubkey).
 */
export interface DefaultContractParams {
    /** User's public key descriptor (tr(...) format) */
    pubKey: string;
    /** Server's public key descriptor (tr(...) format) */
    serverPubKey: string;
    /** CSV timelock for the exit path */
    csvTimelock: RelativeTimelock;
}

/**
 * Extract a public key as bytes from either descriptor or raw hex.
 * Used internally to get the actual pubkey for script creation.
 */
function extractPubKeyBytes(value: string): Uint8Array {
    // Normalize first (wraps raw hex as tr(hex))
    const descriptor = normalizeToDescriptor(value);
    // Extract pubkey from simple descriptor
    const pubKeyHex = extractPubKey(descriptor);
    return hex.decode(pubKeyHex);
}

/**
 * Handler for default wallet VTXOs.
 *
 * Default contracts use the standard forfeit + exit tapscript:
 * - forfeit: (Alice + Server) multisig for collaborative spending
 * - exit: (Alice) + CSV timelock for unilateral exit
 *
 * Public keys are stored as descriptors for future HD wallet support:
 * - Simple format: tr(pubkey_hex)
 * - HD format: tr([fingerprint/path']xpub/0/{index})
 *
 * Legacy hex pubkeys are automatically normalized to tr(pubkey) on read.
 */
export const DefaultContractHandler: ContractHandler<
    DefaultContractParams,
    DefaultVtxo.Script
> = {
    type: "default",

    createScript(params: Record<string, string>): DefaultVtxo.Script {
        const typed = this.deserializeParams(params);
        // Extract actual pubkey bytes from descriptors
        return new DefaultVtxo.Script({
            pubKey: extractPubKeyBytes(typed.pubKey),
            serverPubKey: extractPubKeyBytes(typed.serverPubKey),
            csvTimelock: typed.csvTimelock,
        });
    },

    serializeParams(params: DefaultContractParams): Record<string, string> {
        return {
            pubKey: params.pubKey,
            serverPubKey: params.serverPubKey,
            csvTimelock: timelockToSequence(params.csvTimelock).toString(),
        };
    },

    deserializeParams(params: Record<string, string>): DefaultContractParams {
        const csvTimelock = params.csvTimelock
            ? sequenceToTimelock(Number(params.csvTimelock))
            : DefaultVtxo.Script.DEFAULT_TIMELOCK;
        return {
            // Normalize hex pubkeys to descriptors for backwards compat
            pubKey: normalizeToDescriptor(params.pubKey),
            serverPubKey: normalizeToDescriptor(params.serverPubKey),
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
