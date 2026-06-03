import { hex } from "@scure/base";
import { DefaultVtxo } from "../../script/default";
import { Contract, ContractHandler, Discoverable, PathContext, PathSelection } from "../types";
import type { DiscoveredContract, DiscoveryDeps } from "../types";
import { DefaultContractHandler, DefaultContractParams } from "./default";
import { deriveDescriptorLeafPubKey } from "../../identity/descriptor";
import { timelockToSequence } from "../../utils/timelock";
import { WALLET_RECEIVE_SOURCE } from "../metadata";

/**
 * Typed parameters for boarding contracts.
 *
 * Boarding reuses the exact `default` contract parameter shape
 * (`pubKey` / `serverPubKey` / `csvTimelock`) rather than inventing
 * boarding-specific names — the boarding semantics come from the
 * contract type and from populating `csvTimelock` with the server's
 * boarding-exit delay (`ArkInfo.boardingExitDelay`) instead of the
 * offchain unilateral-exit delay.
 */
export type BoardingContractParams = DefaultContractParams;

/**
 * Handler for the boarding contract (registered type `boarding`).
 *
 * The boarding contract derives the on-chain Bitcoin address used to
 * board funds onto Arkade. It shares the exact `DefaultVtxo.Script`
 * shape with the `default` contract — a Taproot output co-owned by the
 * wallet and the Ark server, with a CSV exit path back to the wallet —
 * and therefore reuses the `default` handler's path logic (forfeit via
 * server cooperation, exit after the boarding CSV).
 *
 * Boarding semantics come entirely from the contract type and from
 * sourcing the CSV timelock from the server's boarding-exit delay
 * (`ArkInfo.boardingExitDelay`), not from renamed parameters. The
 * offchain `default` contract is built from `ArkInfo.unilateralExitDelay`
 * instead, so the two share a script shape but differ in their CSV
 * timelock value. Parameters round-trip through the same
 * `timelockToSequence` / `sequenceToTimelock` helpers and BIP68 sequence
 * encoding as `default` / `delegate`.
 *
 * Like `default` / `delegate`, the boarding handler implements
 * {@link Discoverable.discoverAt} so `wallet.restore()` can rediscover
 * used boarding indices from authoritative on-chain data. It differs from
 * the L2 handlers in its source of truth: boarding probes the **on-chain**
 * UTXO set at its P2TR address (`OnchainProvider.getCoins`) rather than the
 * Ark indexer, and builds its candidate from the boarding-exit CSV
 * (`deps.boardingTimelock`) instead of the unilateral-exit matrix
 * (`deps.csvTimelocks`). When boarding discovery is not plumbed (no
 * `deps.boardingTimelock` / `deps.onchainNetwork`) `discoverAt` no-ops.
 *
 * Identity & the default/boarding collision: a contract's `script` (pkScript)
 * is its unique identity — a script owns exactly one repository row. `boarding`
 * is a first-class type with its own row **when its script is distinct** from
 * the wallet's `default` baseline — the real-world case, since a sound Ark
 * server keeps boardingExitDelay strictly longer than unilateralExitDelay (equal
 * delays would expose the provider to a double-spend). Should those delays ever
 * coincide (a misconfigured/malicious server), the boarding script is
 * byte-identical to the default script and the wallet coalesces the single
 * shared row onto the `default` type ("default wins"; see `ensureWalletContract`)
 * rather than persisting a second row. Either way the funds are equally spendable
 * through the shared `DefaultVtxo.Script` paths. Consumers must NOT rely on
 * `contract.type === "boarding"` to identify the boarding purpose — resolve the
 * boarding script via `wallet.getBoardingAddress()` / `wallet.boardingTapscript`
 * (which never depend on the persisted contract's type) and match by script when
 * needed.
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

    /**
     * Probe the on-chain UTXO set for a boarding output at this HD index.
     *
     * Boarding's source of truth is the **current** on-chain coin set
     * (`OnchainProvider.getCoins`), not the Ark indexer: a boarded (spent)
     * boarding output becomes an L2 VTXO at the receive index, so the
     * indexer probe already keeps the gap window open for it; only an
     * *unspent* boarding output needs the on-chain probe (see plan §2).
     *
     * No-ops (returns `[]`) when boarding discovery is not plumbed — i.e.
     * `deps.boardingTimelock` or `deps.onchainNetwork` is absent — so the
     * scanner unit harness (which sets neither) is unaffected.
     *
     * Equal-delay collision coalescing ("default wins", plan §6-I.3): when
     * the boarding script is byte-identical to a `default` script at this
     * index (a degenerate server with `boardingExitDelay ===
     * unilateralExitDelay`), this emits the hit as a `default` contract
     * rather than a conflicting `boarding` row, so the restore scan's strict
     * `upsertContract` never aborts on a same-script/different-type clash.
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
        // Coalesce onto `default` when the boarding script collides with a
        // `default` candidate at this index. Scripts are byte-identical iff
        // the boarding-exit sequence equals one of the unilateral-exit
        // sequences (same pubKey + serverPubKey + sequence). A `delegate`
        // script carries an extra leaf and can never collide.
        const boardingSeq = timelockToSequence(deps.boardingTimelock);
        const collidesWithDefault = deps.csvTimelocks.some(
            (tl) => timelockToSequence(tl) === boardingSeq,
        );
        const type = collidesWithDefault ? "default" : "boarding";

        return [
            {
                type,
                params: {
                    pubKey: hex.encode(pubKey),
                    serverPubKey: hex.encode(deps.serverPubKey),
                    csvTimelock: boardingSeq.toString(),
                },
                script: scriptHex,
                // The persisted row's `address` is the *Ark* address (not the
                // on-chain P2TR), matching the row registered at init so the
                // ContractWatcher keeps monitoring the same L2 script and the
                // VTXO repository bucket lines up (plan §6-I.4). The P2TR is
                // recomputed from params only for the `getCoins` probe.
                address: script.address(deps.network.hrp, deps.serverPubKey).encode(),
                // Tag rotated rows (index > 0) so boot resolution can find the
                // newest boarding address and descriptor-aware signing can
                // recover the per-index key (plan §6-II/§6-III.3). The index-0
                // baseline stays untagged, matching `default`/`delegate`.
                ...(index > 0
                    ? {
                          metadata: {
                              source: WALLET_RECEIVE_SOURCE,
                              signingDescriptor: descriptor,
                          },
                      }
                    : {}),
            },
        ];
    },
};
