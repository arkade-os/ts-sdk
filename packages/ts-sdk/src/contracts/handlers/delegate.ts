import { hex } from "@scure/base";
import { DelegateVtxo } from "../../script/delegate";
import { RelativeTimelock } from "../../script/tapscript";
import { Contract, ContractHandler, Discoverable, PathContext, PathSelection } from "../types";
import type { DiscoveredContract, DiscoveryDeps } from "../types";
import {
    discoverIndexerCandidates,
    discoverAtViaRange,
    extractPubKeyBytes,
    deserializeCsvTimelock,
    rotatedReceiveMetadata,
    buildSignerTimelockCandidates,
    selectForfeitOrExitPath,
    forfeitExitAllPaths,
    forfeitExitSpendablePaths,
} from "./helpers";
import { timelockToSequence } from "../../utils/timelock";

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
        return {
            pubKey: extractPubKeyBytes(params.pubKey),
            serverPubKey: extractPubKeyBytes(params.serverPubKey),
            delegatePubKey: extractPubKeyBytes(params.delegatePubKey),
            csvTimelock: deserializeCsvTimelock(params.csvTimelock),
        };
    },

    selectPath(
        script: DelegateVtxo.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection | null {
        return selectForfeitOrExitPath(script, contract, context);
    },

    getAllSpendingPaths(
        script: DelegateVtxo.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return [
            ...forfeitExitAllPaths(script, contract, context),
            // Delegate path (Alice + Delegate + Server) — collaborative only,
            // and last so the shared forfeit/exit ordering is unchanged.
            ...(context.collaborative ? [{ leaf: script.delegate() }] : []),
        ];
    },

    getSpendablePaths(
        script: DelegateVtxo.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return forfeitExitSpendablePaths(script, contract, context);
    },

    discoverAt: discoverAtViaRange(discoverDelegateRange),

    discoverRange: discoverDelegateRange,
};

function discoverDelegateRange(
    entries: readonly { index: number; descriptor: string }[],
    deps: DiscoveryDeps,
): Promise<Map<number, DiscoveredContract[]>> {
    // Not a delegate wallet: still answer for every requested index, since an
    // omission would read as indeterminate and truncate the scan.
    const delegatePubKey = deps.delegatePubKey;
    if (!delegatePubKey) {
        return Promise.resolve(new Map(entries.map((e) => [e.index, []])));
    }

    return discoverIndexerCandidates(
        deps.indexerProvider,
        entries,
        // The delegate key is constant across the cross-product, so it rides
        // the closure rather than being repeated on every candidate.
        (_index, descriptor) =>
            buildSignerTimelockCandidates(
                descriptor,
                deps,
                (opts) => new DelegateVtxo.Script({ ...opts, delegatePubKey }),
            ),
        // The matched signer is threaded through script, params, and address so
        // signing/forfeit later resolves the right key.
        (c, index, descriptor) => ({
            type: "delegate",
            params: {
                pubKey: hex.encode(c.pubKey),
                serverPubKey: hex.encode(c.serverPubKey),
                delegatePubKey: hex.encode(delegatePubKey),
                csvTimelock: timelockToSequence(c.csvTimelock).toString(),
            },
            script: c.scriptHex,
            address: c.script.address(deps.network.hrp, c.serverPubKey).encode(),
            ...rotatedReceiveMetadata(index, descriptor),
        }),
    );
}
