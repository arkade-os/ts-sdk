import { DefaultVtxo } from "../../script/default";
import { Contract, ContractHandler, PathContext, PathSelection } from "../types";
import { DefaultContractHandler, DefaultContractParams } from "./default";

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
 * Unlike `default` / `delegate`, the boarding handler deliberately does
 * **not** implement {@link Discoverable.discoverAt}: branch/index
 * selection for HD wallets is owned by the wallet / address-provider
 * layer, which hands this handler an already-derived pubkey. As a result
 * `isDiscoverable(BoardingContractHandler)` is `false`.
 *
 * Identity & the default/boarding collision: a contract's `script` (pkScript)
 * is its unique identity — a script owns exactly one repository row. `boarding`
 * is a first-class type with its own row **when its script is distinct** from
 * the wallet's `default` baseline (the usual case, since boardingExitDelay and
 * unilateralExitDelay differ). When those delays coincide the boarding script
 * is byte-identical to the default script; the single shared row may then carry
 * **either** `type` (`default` or `boarding`), and the funds are equally
 * spendable through the shared `DefaultVtxo.Script` paths regardless. Consumers
 * therefore must NOT rely on `contract.type === "boarding"` to identify the
 * boarding purpose in that collision case — resolve the boarding script via
 * `wallet.getBoardingAddress()` / `wallet.boardingTapscript` (which never depend
 * on the persisted contract's type) and match by script when needed.
 */
export const BoardingContractHandler: ContractHandler<BoardingContractParams, DefaultVtxo.Script> =
    {
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
    };
