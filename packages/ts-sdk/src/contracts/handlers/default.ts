import { hex } from "@scure/base";
import { DefaultVtxo } from "../../script/default";
import { RelativeTimelock } from "../../script/tapscript";
import { Contract, ContractHandler, Discoverable, PathContext, PathSelection } from "../types";
import type { CandidateDeps, DiscoveredContract, DiscoveryDeps } from "../types";
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
        return selectForfeitOrExitPath(script, contract, context);
    },

    getAllSpendingPaths(
        script: DefaultVtxo.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return forfeitExitAllPaths(script, contract, context);
    },

    getSpendablePaths(
        script: DefaultVtxo.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return forfeitExitSpendablePaths(script, contract, context);
    },

    discoverAt: discoverAtViaRange(discoverDefaultRange),

    discoverRange: discoverDefaultRange,

    candidatesAt: defaultCandidatesAt,
};

/**
 * The signer × CSV-timelock cross-product under the index's leaf key. Each
 * candidate's own signer is threaded through its params and address so
 * signing/forfeit later resolves the right key.
 */
function defaultCandidatesAt(
    _index: number,
    descriptor: string,
    deps: CandidateDeps,
): DiscoveredContract[] {
    return buildSignerTimelockCandidates(
        descriptor,
        deps,
        (opts) => new DefaultVtxo.Script(opts),
    ).map((c) => ({
        type: "default",
        params: {
            pubKey: hex.encode(c.pubKey),
            serverPubKey: hex.encode(c.serverPubKey),
            csvTimelock: timelockToSequence(c.csvTimelock).toString(),
        },
        script: c.scriptHex,
        address: c.script.address(deps.network.hrp, c.serverPubKey).encode(),
    }));
}

function discoverDefaultRange(
    entries: readonly { index: number; descriptor: string }[],
    deps: DiscoveryDeps,
): Promise<Map<number, DiscoveredContract[]>> {
    return discoverIndexerCandidates(
        deps.indexerProvider,
        entries,
        (index, descriptor) => defaultCandidatesAt(index, descriptor, deps),
        (c, index, descriptor) => ({ ...c, ...rotatedReceiveMetadata(index, descriptor) }),
    );
}
