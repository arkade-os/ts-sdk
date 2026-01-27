import { hex } from "@scure/base";
import { VHTLC } from "../../script/vhtlc";
import { RelativeTimelock } from "../../script/tapscript";
import {
    Contract,
    ContractHandler,
    PathContext,
    PathSelection,
} from "../types";
import { resolveRole, sequenceToTimelock, timelockToSequence } from "./helpers";

/**
 * Typed parameters for VHTLC contracts.
 */
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
export const VHTLCContractHandler: ContractHandler<
    VHTLCContractParams,
    VHTLC.Script
> = {
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
            claimDelay: timelockToSequence(
                params.unilateralClaimDelay
            ).toString(),
            refundDelay: timelockToSequence(
                params.unilateralRefundDelay
            ).toString(),
            refundNoReceiverDelay: timelockToSequence(
                params.unilateralRefundWithoutReceiverDelay
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
            unilateralRefundDelay: sequenceToTimelock(
                Number(params.refundDelay)
            ),
            unilateralRefundWithoutReceiverDelay: sequenceToTimelock(
                Number(params.refundNoReceiverDelay)
            ),
        };
    },

    /**
     * Select spending path based on context.
     *
     * Role is determined from `context.role` or by matching `context.walletPubKey`
     * against sender/receiver in contract params.
     */
    selectPath(
        script: VHTLC.Script,
        contract: Contract,
        context: PathContext
    ): PathSelection | null {
        const role = resolveRole(contract, context);
        const preimage = contract.params?.preimage;
        const refundLocktime = BigInt(contract.params.refundLocktime);
        const currentTimeSec = Math.floor(context.currentTime / 1000);

        if (!role) {
            return null;
        }

        if (context.collaborative) {
            if (role === "receiver" && preimage) {
                return {
                    leaf: script.claim(),
                    extraWitness: [hex.decode(preimage)],
                };
            }

            if (role === "sender" && BigInt(currentTimeSec) >= refundLocktime) {
                return { leaf: script.refundWithoutReceiver() };
            }

            return null;
        }

        // Unilateral paths
        if (role === "receiver" && preimage) {
            return {
                leaf: script.unilateralClaim(),
                extraWitness: [hex.decode(preimage)],
                sequence: Number(contract.params.claimDelay),
            };
        }

        if (role === "sender") {
            return {
                leaf: script.unilateralRefundWithoutReceiver(),
                sequence: Number(contract.params.refundNoReceiverDelay),
            };
        }

        return null;
    },

    /**
     * Get all currently spendable paths.
     *
     * Role is determined from `context.role` or by matching `context.walletPubKey`
     * against sender/receiver in contract params.
     */
    getSpendablePaths(
        script: VHTLC.Script,
        contract: Contract,
        context: PathContext
    ): PathSelection[] {
        const role = resolveRole(contract, context);
        const paths: PathSelection[] = [];

        if (!role) {
            return paths;
        }

        const preimage = contract.params?.preimage;
        const refundLocktime = BigInt(contract.params.refundLocktime);
        const currentTimeSec = Math.floor(context.currentTime / 1000);

        if (context.collaborative) {
            // Collaborative paths
            if (role === "receiver" && preimage) {
                paths.push({
                    leaf: script.claim(),
                    extraWitness: [hex.decode(preimage)],
                });
            }
            if (role === "sender" && BigInt(currentTimeSec) >= refundLocktime) {
                paths.push({ leaf: script.refundWithoutReceiver() });
            }
        } else {
            // Unilateral paths (always include if role matches, CSV checked at tx time)
            if (role === "receiver" && preimage) {
                paths.push({
                    leaf: script.unilateralClaim(),
                    extraWitness: [hex.decode(preimage)],
                    sequence: Number(contract.params.claimDelay),
                });
            }
            if (role === "sender") {
                paths.push({
                    leaf: script.unilateralRefundWithoutReceiver(),
                    sequence: Number(contract.params.refundNoReceiverDelay),
                });
            }
        }

        return paths;
    },
};
