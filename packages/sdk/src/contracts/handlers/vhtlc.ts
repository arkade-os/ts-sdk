import { hex } from "@scure/base";
import { VHTLC } from "../../script/vhtlc";
import { RelativeTimelock } from "../../script/tapscript";
import {
    Contract,
    ContractHandler,
    DerivedContractTapscripts,
    PathContext,
    PathSelection,
    TapscriptDeriving,
} from "../types";
import {
    assertVhtlcSpendableNow,
    deriveVhtlcTapscripts,
    selectVhtlcPath,
    vhtlcAllSpendingPaths,
    vhtlcSpendablePaths,
} from "./helpers";
import { sequenceToTimelock, timelockToSequence } from "../../utils/timelock";

/** Typed parameters for VHTLC contracts. */
export interface VHTLCContractParams {
    sender: Uint8Array;
    receiver: Uint8Array;
    server: Uint8Array;
    preimageHash: Uint8Array;
    refundLocktime: bigint;
    unilateralClaimDelay: RelativeTimelock;
    unilateralRefundDelay: RelativeTimelock;
    unilateralRefundWithoutReceiverDelay: RelativeTimelock;
}

/**
 * Handler for Virtual Hash Time Lock Contract (VHTLC).
 *
 * VHTLC supports multiple spending paths:
 *
 * Collaborative paths (with server):
 * - claim: Receiver + Server with preimage
 * - refund: Sender + Receiver + Server
 * - refundWithoutReceiver: Sender + Server after CLTV locktime
 *
 * Unilateral paths (without server):
 * - unilateralClaim: Receiver with preimage after CSV delay
 * - unilateralRefund: Sender + Receiver after CSV delay
 * - unilateralRefundWithoutReceiver: Sender after CSV delay
 */
export const VHTLCContractHandler: ContractHandler<VHTLCContractParams, VHTLC.Script> &
    TapscriptDeriving<VHTLC.Script> = {
    type: "vhtlc",

    createScript(params: Record<string, string>): VHTLC.Script {
        const typed = this.deserializeParams(params);
        return new VHTLC.Script(typed);
    },

    serializeParams(params: VHTLCContractParams): Record<string, string> {
        return {
            sender: hex.encode(params.sender),
            receiver: hex.encode(params.receiver),
            server: hex.encode(params.server),
            hash: hex.encode(params.preimageHash),
            refundLocktime: params.refundLocktime.toString(),
            claimDelay: timelockToSequence(params.unilateralClaimDelay).toString(),
            refundDelay: timelockToSequence(params.unilateralRefundDelay).toString(),
            refundNoReceiverDelay: timelockToSequence(
                params.unilateralRefundWithoutReceiverDelay,
            ).toString(),
        };
    },

    deserializeParams(params: Record<string, string>): VHTLCContractParams {
        return {
            sender: hex.decode(params.sender),
            receiver: hex.decode(params.receiver),
            server: hex.decode(params.server),
            preimageHash: hex.decode(params.hash),
            refundLocktime: BigInt(params.refundLocktime),
            unilateralClaimDelay: sequenceToTimelock(Number(params.claimDelay)),
            unilateralRefundDelay: sequenceToTimelock(Number(params.refundDelay)),
            unilateralRefundWithoutReceiverDelay: sequenceToTimelock(
                Number(params.refundNoReceiverDelay),
            ),
        };
    },

    /**
     * Select spending path based on context. Role comes from `context.role` or from matching
     * `context.walletDescriptor` against sender/receiver.
     */
    selectPath(
        script: VHTLC.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection | null {
        return selectVhtlcPath(script, contract, context);
    },

    /** All possible spending paths (no timelock checks); role as in {@link selectPath}. */
    getAllSpendingPaths(
        script: VHTLC.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return vhtlcAllSpendingPaths(script, contract, context);
    },

    getSpendablePaths(
        script: VHTLC.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        return vhtlcSpendablePaths(script, contract, context);
    },

    /**
     * Refuse an explicit spend of a lockup whose refund path has not opened.
     * Shared with the v2 handler so the two cannot drift.
     * @see assertVhtlcSpendableNow for why this is the one certain case.
     */
    assertSpendableNow(_script: VHTLC.Script, contract: Contract, context: PathContext): void {
        assertVhtlcSpendableNow(contract, context);
    },

    /**
     * Never. A live VHTLC is escrow: generic selection (send, settle, renewal, offboard) would
     * move the lockup out from under a swap the counterparty may still complete, or race a claim.
     *
     * The stamped leaf is the sender's own CLTV refund, so this is not about destroying the
     * VTXO: an escrowed lockup must not count toward the `available` balance, and generic
     * renewal (`runPeriodicSettle`, unprompted without an explicit `settlementConfig`) must not
     * silently execute a refund nobody asked for.
     *
     * **Inseparable from {@link deriveTapscripts}**: deriving the leaf without closing this gate
     * hands renewal an escrow. Recovery filters on {@link assertSpendableNow} instead; this
     * permanent gate would strand a matured lockup.
     */
    isGenericallySpendable: () => false,

    /**
     * The annotation leaf stamped onto every VTXO locked to this contract.
     *
     * **Required, not an optimization.** Without it `deriveContractTapscripts` falls back to
     * `script.forfeit()`, which no VHTLC script has, so the contract's VTXOs are dropped before
     * persisting: balance invisible, `getSyncState()` degraded forever.
     *
     * `refundWithoutReceiver` is the only collaborative path this wallet can satisfy as sender
     * (kept in step with `selectPath`): the claim leaves need the preimage, and `refund` /
     * `unilateralRefund` need a counterparty signature the protocol can't request. V1 has no
     * covenant leaves.
     *
     * **It carries a CLTV**: a settlement on it is rejected until `refundLocktime` matures, and
     * the per-contract annotation knows no clock, so `recoverVtxos` filters on
     * {@link assertSpendableNow}. **Role-blind**: a receiver's row gets the same leaf, satisfiable
     * only by the `sender` key holder; anyone else fails at intent registration.
     */
    deriveTapscripts(script: VHTLC.Script): DerivedContractTapscripts {
        return deriveVhtlcTapscripts(script);
    },
};
