import { hex } from "@scure/base";
import { DelegateVtxo } from "../../script/delegate";
import { isDelegateeVtxoOptions, type DelegateeVtxoOptions } from "../../script/delegatee";
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
 * Typed parameters for DelegateVtxo contracts.
 */
export interface LegacyDelegateContractParams {
    pubKey: Uint8Array;
    serverPubKey: Uint8Array;
    delegatePubKey: Uint8Array;
    csvTimelock: RelativeTimelock;
}

export type DelegateContractParams = LegacyDelegateContractParams | DelegateeVtxoOptions;

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
        const base = {
            pubKey: hex.encode(params.pubKey),
            serverPubKey: hex.encode(params.serverPubKey),
            delegatePubKey: hex.encode(params.delegatePubKey),
            csvTimelock: timelockToSequence(params.csvTimelock).toString(),
        };
        if (!isDelegateeVtxoOptions(params)) return base;
        return {
            ...base,
            emulatorPubKey: hex.encode(params.emulatorPubKey),
            renewalWindow: params.renewalWindow.toString(),
            maxFee: params.maxFee.toString(),
        };
    },

    deserializeParams(params: Record<string, string>): DelegateContractParams {
        if (params.emulatorPubKey !== undefined) {
            return {
                pubKey: extractPubKeyBytes(params.pubKey),
                serverPubKey: extractPubKeyBytes(params.serverPubKey),
                delegatePubKey: decodeRawPubKey(params.delegatePubKey),
                emulatorPubKey: decodeRawPubKey(params.emulatorPubKey),
                renewalWindow: Number(params.renewalWindow),
                maxFee: Number(params.maxFee),
                csvTimelock: deserializeCsvTimelock(params.csvTimelock),
            };
        }
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

    /** The wallet's own money, delegated signing. */
    isGenericallySpendable: () => true,

    discoverAt: discoverAtViaRange(discoverDelegateRange),

    discoverRange: discoverDelegateRange,

    candidatesAt: delegateCandidatesAt,
};

/**
 * The `default` cross-product (@see DefaultContractHandler.candidatesAt) under
 * the wallet's delegate key. Empty for a non-delegate wallet.
 */
function delegateCandidatesAt(
    _index: number,
    descriptor: string,
    deps: CandidateDeps,
): DiscoveredContract[] {
    if (deps.delegatee) {
        return buildSignerTimelockCandidates(
            descriptor,
            deps,
            (opts) => new DelegateVtxo.Script({ ...opts, ...deps.delegatee! }),
        ).map((c) => {
            const script = new DelegateVtxo.Script({
                ...c,
                ...deps.delegatee!,
            });
            return {
                type: "delegate",
                params: DelegateContractHandler.serializeParams(script.options),
                script: c.scriptHex,
                address: script.address(deps.network.hrp, c.serverPubKey).encode(),
            };
        });
    }

    const delegatePubKey = deps.delegatePubKey;
    if (!delegatePubKey) return [];

    return buildSignerTimelockCandidates(
        descriptor,
        deps,
        (opts) => new DelegateVtxo.Script({ ...opts, delegatePubKey }),
    ).map((c) => ({
        type: "delegate",
        params: {
            pubKey: hex.encode(c.pubKey),
            serverPubKey: hex.encode(c.serverPubKey),
            delegatePubKey: hex.encode(delegatePubKey),
            csvTimelock: timelockToSequence(c.csvTimelock).toString(),
        },
        script: c.scriptHex,
        address: c.script.address(deps.network.hrp, c.serverPubKey).encode(),
    }));
}

function decodeRawPubKey(value: string): Uint8Array {
    const key = hex.decode(value);
    if (
        (key.length !== 32 && key.length !== 33) ||
        (key.length === 33 && key[0] !== 0x02 && key[0] !== 0x03)
    ) {
        throw new Error("invalid delegatee public key");
    }
    return key;
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

    return discoverIndexerCandidates(
        deps.indexerProvider,
        entries,
        (index, descriptor) => delegateCandidatesAt(index, descriptor, deps),
        (c, index, descriptor) => ({ ...c, ...rotatedReceiveMetadata(index, descriptor) }),
    );
}
