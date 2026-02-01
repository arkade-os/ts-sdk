import { hex } from "@scure/base";
import { DefaultVtxo } from "../../script/default";
import { RelativeTimelock } from "../../script/tapscript";
import {
    Contract,
    ContractHandler,
    PathContext,
    PathSelection,
    WalletDescriptorInfo,
} from "../types";
import type { DescriptorProvider } from "../../identity";
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
 * Typed parameters for Boarding contracts.
 * Same structure as DefaultContractParams.
 */
export interface BoardingContractParams {
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
    const descriptor = normalizeToDescriptor(value);
    const pubKeyHex = extractPubKey(descriptor);
    return hex.decode(pubKeyHex);
}

/**
 * Handler for boarding UTXOs.
 *
 * Boarding contracts are onchain UTXOs waiting to be settled into VTXOs.
 * They use the same script structure as default VTXOs:
 * - forfeit: (Alice + Server) multisig for collaborative spending (joining a batch)
 * - exit: (Alice) + CSV timelock for unilateral exit
 *
 * The key difference from default contracts is that boarding UTXOs are onchain,
 * not virtual. They represent funds waiting to enter the Ark protocol.
 *
 * Public keys are stored as descriptors for HD wallet support:
 * - Simple format: tr(pubkey_hex)
 * - HD format: tr([fingerprint/path']xpub/0/{index})
 */
export const BoardingContractHandler: ContractHandler<
    BoardingContractParams,
    DefaultVtxo.Script
> = {
    type: "boarding",

    createScript(params: Record<string, string>): DefaultVtxo.Script {
        const typed = this.deserializeParams(params);
        return new DefaultVtxo.Script({
            pubKey: extractPubKeyBytes(typed.pubKey),
            serverPubKey: extractPubKeyBytes(typed.serverPubKey),
            csvTimelock: typed.csvTimelock,
        });
    },

    serializeParams(params: BoardingContractParams): Record<string, string> {
        return {
            pubKey: params.pubKey,
            serverPubKey: params.serverPubKey,
            csvTimelock: timelockToSequence(params.csvTimelock).toString(),
        };
    },

    deserializeParams(params: Record<string, string>): BoardingContractParams {
        const csvTimelock = params.csvTimelock
            ? sequenceToTimelock(Number(params.csvTimelock))
            : DefaultVtxo.Script.DEFAULT_TIMELOCK;
        return {
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
        const descriptor = contract.params.pubKey;

        if (context.collaborative) {
            // Use forfeit path for joining a batch
            return { leaf: script.forfeit(), descriptor };
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
            descriptor,
        };
    },

    getAllSpendingPaths(
        script: DefaultVtxo.Script,
        contract: Contract,
        context: PathContext
    ): PathSelection[] {
        const paths: PathSelection[] = [];
        const descriptor = contract.params.pubKey;

        // Forfeit path available with server cooperation
        if (context.collaborative) {
            paths.push({ leaf: script.forfeit(), descriptor });
        }

        // Exit path always possible (CSV checked at tx time)
        const exitPath: PathSelection = { leaf: script.exit(), descriptor };
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
        const descriptor = contract.params.pubKey;

        if (context.collaborative) {
            paths.push({ leaf: script.forfeit(), descriptor });
        }

        const exitSequence = contract.params.csvTimelock
            ? Number(contract.params.csvTimelock)
            : undefined;

        if (isCsvSpendable(context, exitSequence)) {
            const exitPath: PathSelection = { leaf: script.exit(), descriptor };
            if (exitSequence !== undefined) {
                exitPath.sequence = exitSequence;
            }
            paths.push(exitPath);
        }

        return paths;
    },

    getWalletDescriptors(
        contract: Contract,
        identity: DescriptorProvider
    ): WalletDescriptorInfo[] {
        const result: WalletDescriptorInfo[] = [];
        const pubKey = contract.params.pubKey;

        if (pubKey && identity.isOurs(pubKey)) {
            result.push({
                descriptor: pubKey,
                pathNames: ["forfeit", "exit"],
            });
        }
        return result;
    },
};
