import { hex } from "@scure/base";
import { DefaultVtxo } from "../../script/default";
import { RelativeTimelock } from "../../script/tapscript";
import { Contract, ContractHandler, Discoverable, PathContext, PathSelection } from "../types";
import type { DiscoveredContract, DiscoveryDeps } from "../types";
import { isCsvSpendable } from "./helpers";
import { sequenceToTimelock, timelockToSequence } from "../../utils/timelock";
import {
    normalizeToDescriptor,
    extractPubKey,
    deriveDescriptorLeafPubKey,
} from "../../identity/descriptor";
import { WALLET_RECEIVE_SOURCE } from "../metadata";

/**
 * Typed parameters for DefaultVtxo contracts.
 */
export interface DefaultContractParams {
    pubKey: Uint8Array;
    serverPubKey: Uint8Array;
    csvTimelock: RelativeTimelock;
}

/**
 * Extract pubkey bytes from a descriptor or hex string.
 */
function extractPubKeyBytes(value: string): Uint8Array {
    return hex.decode(extractPubKey(normalizeToDescriptor(value)));
}

/**
 * Handler for default wallet VTXOs.
 *
 * Default contracts use the standard forfeit + exit tapscript:
 * - forfeit: (Alice + Server) multisig for collaborative spending
 * - exit: (Alice) + CSV timelock for unilateral exit
 */
export const DefaultContractHandler: ContractHandler<DefaultContractParams, DefaultVtxo.Script> &
    Discoverable = {
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
        // csvTimelock may be absent on legacy/minimal params (e.g. hex pubkeys
        // with no timelock). DefaultVtxo.Script no longer applies its own
        // fallback, so restore it here rather than feeding sequenceToTimelock
        // a NaN (which silently decodes to a zero timelock).
        const csvTimelock =
            params.csvTimelock !== undefined && params.csvTimelock !== ""
                ? sequenceToTimelock(Number(params.csvTimelock))
                : DefaultVtxo.Script.DEFAULT_TIMELOCK;
        return {
            pubKey: extractPubKeyBytes(params.pubKey),
            serverPubKey: extractPubKeyBytes(params.serverPubKey),
            csvTimelock,
        };
    },

    selectPath(
        script: DefaultVtxo.Script,
        contract: Contract,
        context: PathContext,
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
        context: PathContext,
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
        context: PathContext,
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

    async discoverAt(
        index: number,
        descriptor: string,
        deps: DiscoveryDeps,
    ): Promise<DiscoveredContract[]> {
        const pubKey = deriveDescriptorLeafPubKey(descriptor);
        const out: DiscoveredContract[] = [];
        // Scan the current signer first, then any deprecated signers, so a VTXO
        // minted under a now-rotated server key is still discovered. The matched
        // signer is threaded through the script, persisted params, and encoded
        // address so signing/forfeit later resolves the right key. Dedup by
        // scriptHex: a deprecated signer that produced no rotation yields the
        // same scripts as the current key and must not emit a duplicate.
        const signers = [deps.serverPubKey, ...(deps.deprecatedSignerPubKeys ?? [])];
        const seen = new Set<string>();
        for (const serverPubKey of signers) {
            for (const csvTimelock of deps.csvTimelocks) {
                const script = new DefaultVtxo.Script({
                    pubKey,
                    serverPubKey,
                    csvTimelock,
                });
                const scriptHex = hex.encode(script.pkScript);
                if (seen.has(scriptHex)) continue;
                seen.add(scriptHex);
                const { vtxos } = await deps.indexerProvider.getVtxos({
                    scripts: [scriptHex],
                });
                if (vtxos.length === 0) continue;
                out.push({
                    type: "default",
                    params: {
                        pubKey: hex.encode(pubKey),
                        serverPubKey: hex.encode(serverPubKey),
                        csvTimelock: timelockToSequence(csvTimelock).toString(),
                    },
                    script: scriptHex,
                    address: script.address(deps.network.hrp, serverPubKey).encode(),
                    ...(index > 0
                        ? {
                              metadata: {
                                  source: WALLET_RECEIVE_SOURCE,
                                  signingDescriptor: descriptor,
                              },
                          }
                        : {}),
                });
            }
        }
        return out;
    },
};
