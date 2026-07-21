import { hex } from "@scure/base";
import { DelegateVtxo } from "../../script/delegate";
import { RelativeTimelock } from "../../script/tapscript";
import { Contract, ContractHandler, Discoverable, PathContext, PathSelection } from "../types";
import type { DiscoveredContract, DiscoveryDeps } from "../types";
import { isCsvSpendable, discoverIndexerCandidates } from "./helpers";
import { sequenceToTimelock, timelockToSequence } from "../../utils/timelock";
import { deriveDescriptorLeafPubKey } from "../../identity/descriptor";
import { WALLET_RECEIVE_SOURCE } from "../metadata";

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
 * Handler for delegate wallet virtual outputs.
 *
 * Delegate contracts extend the default tapscript with an additional delegate path:
 * - forfeit: (Alice + Server) multisig for collaborative spending
 * - exit: (Alice) + CSV timelock for unilateral exit
 * - delegate: (Alice + Delegate + Server) multisig for delegated renewal
 */
export const DelegateContractHandler: ContractHandler<DelegateContractParams, DelegateVtxo.Script> &
    Discoverable = {
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
        const csvTimelock = sequenceToTimelock(Number(params.csvTimelock));
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
        context: PathContext,
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
        context: PathContext,
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
        return (await discoverDelegateRange([{ index, descriptor }], deps)).get(index) ?? [];
    },

    discoverRange: discoverDelegateRange,
};

interface DelegateCandidate {
    pubKey: Uint8Array;
    serverPubKey: Uint8Array;
    delegatePubKey: Uint8Array;
    csvTimelock: RelativeTimelock;
    script: DelegateVtxo.Script;
    scriptHex: string;
}

/**
 * Candidate scripts for one wallet index: current signer first, then any
 * deprecated signers, each crossed with the CSV-timelock matrix (see
 * `DefaultContractHandler` for the rationale). Dedup by scriptHex so a
 * non-rotating signer is neither probed nor emitted twice; the current signer
 * wins the attribution.
 */
function buildDelegateCandidates(
    descriptor: string,
    deps: DiscoveryDeps & { delegatePubKey: Uint8Array },
): DelegateCandidate[] {
    const pubKey = deriveDescriptorLeafPubKey(descriptor);
    const signers = [deps.serverPubKey, ...(deps.deprecatedSignerPubKeys ?? [])];
    const seen = new Set<string>();
    const candidates: DelegateCandidate[] = [];
    for (const serverPubKey of signers) {
        for (const csvTimelock of deps.csvTimelocks) {
            const script = new DelegateVtxo.Script({
                pubKey,
                serverPubKey,
                delegatePubKey: deps.delegatePubKey,
                csvTimelock,
            });
            const scriptHex = hex.encode(script.pkScript);
            if (seen.has(scriptHex)) continue;
            seen.add(scriptHex);
            candidates.push({
                pubKey,
                serverPubKey,
                delegatePubKey: deps.delegatePubKey,
                csvTimelock,
                script,
                scriptHex,
            });
        }
    }
    return candidates;
}

function discoverDelegateRange(
    entries: readonly { index: number; descriptor: string }[],
    deps: DiscoveryDeps,
): Promise<Map<number, DiscoveredContract[]>> {
    // Not a delegate wallet: still answer for every requested index, since an
    // omission would read as indeterminate and truncate the scan.
    if (!deps.delegatePubKey) {
        return Promise.resolve(new Map(entries.map((e) => [e.index, []])));
    }
    const delegateDeps = { ...deps, delegatePubKey: deps.delegatePubKey };

    return discoverIndexerCandidates(
        deps.indexerProvider,
        entries,
        (_index, descriptor) => buildDelegateCandidates(descriptor, delegateDeps),
        // The matched signer is threaded through script, params, and address so
        // signing/forfeit later resolves the right key.
        (c, index, descriptor) => ({
            type: "delegate",
            params: {
                pubKey: hex.encode(c.pubKey),
                serverPubKey: hex.encode(c.serverPubKey),
                delegatePubKey: hex.encode(c.delegatePubKey),
                csvTimelock: timelockToSequence(c.csvTimelock).toString(),
            },
            script: c.scriptHex,
            address: c.script.address(deps.network.hrp, c.serverPubKey).encode(),
            ...(index > 0
                ? {
                      metadata: {
                          source: WALLET_RECEIVE_SOURCE,
                          signingDescriptor: descriptor,
                      },
                  }
                : {}),
        }),
    );
}
