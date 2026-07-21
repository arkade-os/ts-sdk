import { hex } from "@scure/base";
import { DefaultVtxo } from "../../script/default";
import { RelativeTimelock } from "../../script/tapscript";
import { Contract, ContractHandler, Discoverable, PathContext, PathSelection } from "../types";
import type { DiscoveredContract, DiscoveryDeps } from "../types";
import {
    isCsvSpendable,
    discoverIndexerCandidates,
    discoverAtViaRange,
    extractPubKeyBytes,
    deserializeCsvTimelock,
    rotatedReceiveMetadata,
} from "./helpers";
import { timelockToSequence } from "../../utils/timelock";
import { deriveDescriptorLeafPubKey } from "../../identity/descriptor";

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
        return {
            pubKey: extractPubKeyBytes(params.pubKey),
            serverPubKey: extractPubKeyBytes(params.serverPubKey),
            csvTimelock: deserializeCsvTimelock(params.csvTimelock),
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

    discoverAt: discoverAtViaRange(discoverDefaultRange),

    discoverRange: discoverDefaultRange,
};

/**
 * Candidate scripts for one wallet index: the current signer first, then any
 * deprecated signers (so a VTXO minted under a now-rotated server key is still
 * discovered), each crossed with the CSV-timelock matrix. Dedup by scriptHex —
 * a deprecated signer that produced no rotation yields the same scripts as the
 * current key, so it must neither be probed nor emitted twice; the current
 * signer wins the attribution.
 */
function buildDefaultCandidates(descriptor: string, deps: DiscoveryDeps): DefaultCandidate[] {
    const pubKey = deriveDescriptorLeafPubKey(descriptor);
    const signers = [deps.serverPubKey, ...(deps.deprecatedSignerPubKeys ?? [])];
    const seen = new Set<string>();
    const candidates: DefaultCandidate[] = [];
    for (const serverPubKey of signers) {
        for (const csvTimelock of deps.csvTimelocks) {
            const script = new DefaultVtxo.Script({ pubKey, serverPubKey, csvTimelock });
            const scriptHex = hex.encode(script.pkScript);
            if (seen.has(scriptHex)) continue;
            seen.add(scriptHex);
            candidates.push({ pubKey, serverPubKey, csvTimelock, script, scriptHex });
        }
    }
    return candidates;
}

interface DefaultCandidate {
    pubKey: Uint8Array;
    serverPubKey: Uint8Array;
    csvTimelock: RelativeTimelock;
    script: DefaultVtxo.Script;
    scriptHex: string;
}

function discoverDefaultRange(
    entries: readonly { index: number; descriptor: string }[],
    deps: DiscoveryDeps,
): Promise<Map<number, DiscoveredContract[]>> {
    return discoverIndexerCandidates(
        deps.indexerProvider,
        entries,
        (_index, descriptor) => buildDefaultCandidates(descriptor, deps),
        // The matched signer is threaded through the script (already built),
        // the persisted params, and the encoded address so signing/forfeit
        // later resolves the right key.
        (c, index, descriptor) => ({
            type: "default",
            params: {
                pubKey: hex.encode(c.pubKey),
                serverPubKey: hex.encode(c.serverPubKey),
                csvTimelock: timelockToSequence(c.csvTimelock).toString(),
            },
            script: c.scriptHex,
            address: c.script.address(deps.network.hrp, c.serverPubKey).encode(),
            ...rotatedReceiveMetadata(index, descriptor),
        }),
    );
}
