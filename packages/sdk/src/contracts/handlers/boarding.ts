import { hex } from "@scure/base";
import { DefaultVtxo } from "../../script/default";
import { Contract, ContractHandler, Discoverable, PathContext, PathSelection } from "../types";
import type { DiscoveredContract, DiscoveryDeps } from "../types";
import { DefaultContractHandler, DefaultContractParams } from "./default";
import { deriveDescriptorLeafPubKey } from "../../identity/descriptor";
import { rotatedReceiveMetadata } from "./helpers";

/**
 * Typed parameters for boarding contracts: the `default` shape, with `csvTimelock` carrying the
 * server's boarding-exit delay (`ArkadeInfo.boardingExitDelay`) instead of the unilateral-exit
 * delay.
 */
export type BoardingContractParams = DefaultContractParams;

/**
 * Handler for the boarding contract (registered type `boarding`), which derives the on-chain
 * address used to board funds. Same `DefaultVtxo.Script` shape and path logic as `default`; only
 * the CSV differs (`boardingExitDelay` vs `unilateralExitDelay`).
 *
 * {@link Discoverable.discoverAt} probes the **on-chain** UTXO set at the P2TR address, not the
 * Ark indexer, and no-ops when `deps.boardingTimelock` / `deps.onchainNetwork` are absent.
 *
 * Default/boarding collision: a script owns exactly one repository row. A sound server keeps
 * boardingExitDelay > unilateralExitDelay (equal delays expose it to a double-spend); if they
 * coincide the two scripts are byte-identical. Discovery still emits `type: "boarding"` and the
 * row is resolved first-wins in {@link ContractManager.upsertContract}; the scan probes boarding
 * first so a both-purpose rotated index keeps its on-chain UTXO and any L2 VTXO recoverable.
 * Funds are spendable either way, but consumers must NOT identify boarding by
 * `contract.type === "boarding"` — match by script via `wallet.getBoardingAddress()` /
 * `wallet.boardingTapscript`.
 */
export const BoardingContractHandler: ContractHandler<BoardingContractParams, DefaultVtxo.Script> &
    Discoverable = {
    type: "boarding",

    createScript(params: Record<string, string>): DefaultVtxo.Script {
        return DefaultContractHandler.createScript(params);
    },

    serializeParams(params: BoardingContractParams): Record<string, string> {
        return DefaultContractHandler.serializeParams(params);
    },

    deserializeParams(params: Record<string, string>): BoardingContractParams {
        return DefaultContractHandler.deserializeParams(params);
    },

    selectPath(
        script: DefaultVtxo.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection | null {
        return DefaultContractHandler.selectPath(script, contract, context);
    },

    getAllSpendingPaths(
        script: DefaultVtxo.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return DefaultContractHandler.getAllSpendingPaths(script, contract, context);
    },

    getSpendablePaths(
        script: DefaultVtxo.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return DefaultContractHandler.getSpendablePaths(script, contract, context);
    },

    /** Preserves today's settle/board behaviour. */
    isGenericallySpendable: () => true,

    /**
     * Probe the **current** on-chain coin set for a boarding output at this HD index. Only an
     * unspent boarding output needs this: a boarded one became an L2 VTXO at the receive index,
     * which the indexer probe already covers. Always emits `type: "boarding"` (see the handler
     * doc on collisions); `deps.csvTimelocks` is intentionally not read.
     */
    async discoverAt(
        index: number,
        descriptor: string,
        deps: DiscoveryDeps,
    ): Promise<DiscoveredContract[]> {
        if (!deps.boardingTimelock || !deps.onchainNetwork) return [];

        const pubKey = deriveDescriptorLeafPubKey(descriptor);
        const script = new DefaultVtxo.Script({
            pubKey,
            serverPubKey: deps.serverPubKey,
            csvTimelock: deps.boardingTimelock,
        });
        const onchainAddress = script.onchainAddress(deps.onchainNetwork);

        const coins = await deps.onchainProvider.getCoins(onchainAddress);
        if (coins.length === 0) return [];

        const scriptHex = hex.encode(script.pkScript);

        return [
            {
                type: "boarding",
                params: BoardingContractHandler.serializeParams({
                    pubKey,
                    serverPubKey: deps.serverPubKey,
                    csvTimelock: deps.boardingTimelock,
                }),
                script: scriptHex,
                // The Ark address, not the P2TR: must match the row registered at init so the
                // watcher monitors the same L2 script and the VTXO repository bucket lines up.
                address: script.address(deps.network.hrp, deps.serverPubKey).encode(),
                // Tag rotated rows (index > 0) for boot resolution and per-index signing.
                ...rotatedReceiveMetadata(index, descriptor),
            },
        ];
    },
};
