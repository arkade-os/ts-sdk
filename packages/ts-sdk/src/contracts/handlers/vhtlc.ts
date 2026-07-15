import { hex } from "@scure/base";
import { VHTLC } from "../../script/vhtlc";
import { RelativeTimelock } from "../../script/tapscript";
import { Contract, ContractHandler, PathContext, PathSelection } from "../types";
import { isCltvSatisfied, isCsvSpendable, resolveRole } from "./helpers";
import { sequenceToTimelock, timelockToSequence } from "../../utils/timelock";
import type { ContractTapscripts } from "../../wallet/utils";

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
export const VHTLCContractHandler: ContractHandler<VHTLCContractParams, VHTLC.Script> = {
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
     * VHTLC has no single (owner + server) "forfeit" leaf like
     * `default`/`delegate`/`boarding` — it exposes 6 role- and
     * condition-gated paths (claim / refund / refundWithoutReceiver, each
     * with a unilateral variant), and which one applies depends on
     * `contract.params` (role, preimage) and timing, not just the script.
     *
     * Swap VHTLC VTXOs are NOT spent through this generic forfeit/intent
     * path: the swap layer resolves its own role-specific leaf and signs it
     * directly — see `packages/boltz-swap/src/utils/vhtlc.ts` (`joinBatch`,
     * `claimVHTLCwithOffchainTx`, `refundVHTLCwithOffchainTx`), which builds
     * `ArkTxInput.tapLeafScript` from `vhtlcScript.claim()` /
     * `.refund()` / `.refundWithoutReceiver()` directly and never reads
     * `ExtendedVirtualCoin.forfeitTapLeafScript`/`intentTapLeafScript`. These
     * fields exist here only so `ContractWatcher`/`ContractManager.annotateVtxos`
     * don't crash on a registered `vhtlc` contract and so a valid `tapTree` is
     * available for encoding/inspection.
     *
     * We return `claim()` — the receiver+server path gated on a HASH160
     * preimage — specifically because it CANNOT be completed by the wallet's
     * *other* generic forfeit-signing path,
     * `Wallet.handleSettlementFinalizationEvent` (`wallet/wallet.ts`), which
     * never supplies the required preimage witness element. That path is
     * reachable from `wallet.settle()` (called with no params) and
     * `VtxoManager.recoverVtxos()`, and — unlike `getWalletScripts()` /
     * `getScriptMap()`, which deliberately scope to
     * `type: ["default", "delegate"]` — `Wallet.getVtxos()` /
     * `ContractManager.getContractsWithVtxos()` do NOT filter by contract
     * type, so a live `vhtlc` contract's VTXO is a candidate input there
     * today. Picking `claim()` makes any such accidental inclusion fail
     * closed (invalid/incomplete witness) instead of risking a leaf that
     * could be fully signed (e.g. `refundWithoutReceiver()`, if the wallet
     * happens to hold the "sender" role's key for a submarine swap).
     *
     * This is a mitigation, not a fix — see the task report
     * (task-core-annotation-report.md) for the recommended follow-up
     * (excluding non-wallet-owned contract types from the generic
     * settle/recovery input set).
     */
    getContractTapscripts(params: Record<string, string>): ContractTapscripts {
        const script = this.createScript(params);
        return {
            forfeitTapLeafScript: script.claim(),
            intentTapLeafScript: script.claim(),
            tapTree: script.encode(),
        };
    },

    /**
     * Select spending path based on context.
     *
     * Role is determined from `context.role` or by matching
     * `context.walletDescriptor` (preferred) / `context.walletPubKey`
     * against sender/receiver in contract params.
     */
    selectPath(
        script: VHTLC.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection | null {
        const role = resolveRole(contract, context);
        const preimage = contract.params?.preimage;
        const refundLocktime = BigInt(contract.params.refundLocktime);

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

            if (role === "sender" && isCltvSatisfied(context, refundLocktime)) {
                return {
                    leaf: script.refundWithoutReceiver(),
                };
            }

            return null;
        }

        // Unilateral paths
        if (role === "receiver" && preimage) {
            const sequence = Number(contract.params.claimDelay);
            if (!isCsvSpendable(context, sequence)) return null;
            return {
                leaf: script.unilateralClaim(),
                extraWitness: [hex.decode(preimage)],
                sequence,
            };
        }

        if (role === "sender") {
            const sequence = Number(contract.params.refundNoReceiverDelay);
            if (!isCsvSpendable(context, sequence)) return null;
            return {
                leaf: script.unilateralRefundWithoutReceiver(),
                sequence,
            };
        }

        return null;
    },

    /**
     * Get all possible spending paths (no timelock checks).
     *
     * Role is determined from `context.role` or by matching
     * `context.walletDescriptor` (preferred) / `context.walletPubKey`
     * against sender/receiver in contract params.
     */
    getAllSpendingPaths(
        script: VHTLC.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        const role = resolveRole(contract, context);
        const paths: PathSelection[] = [];

        if (!role) {
            return paths;
        }

        const preimage = contract.params?.preimage;

        if (context.collaborative) {
            // Collaborative paths (no timelock checks)
            if (role === "receiver" && preimage) {
                paths.push({
                    leaf: script.claim(),
                    extraWitness: [hex.decode(preimage)],
                });
            }
            if (role === "sender") {
                paths.push({
                    leaf: script.refundWithoutReceiver(),
                });
            }
        } else {
            // Unilateral paths (no timelock checks)
            if (role === "receiver" && preimage) {
                const sequence = Number(contract.params.claimDelay);
                paths.push({
                    leaf: script.unilateralClaim(),
                    extraWitness: [hex.decode(preimage)],
                    sequence,
                });
            }
            if (role === "sender") {
                const sequence = Number(contract.params.refundNoReceiverDelay);
                paths.push({
                    leaf: script.unilateralRefundWithoutReceiver(),
                    sequence,
                });
            }
        }

        return paths;
    },

    getSpendablePaths(
        script: VHTLC.Script,
        contract: Contract,
        context: PathContext,
    ): PathSelection[] {
        const role = resolveRole(contract, context);
        const paths: PathSelection[] = [];

        if (!role) {
            return paths;
        }

        const preimage = contract.params?.preimage;
        const refundLocktime = BigInt(contract.params.refundLocktime);

        if (context.collaborative) {
            if (role === "receiver" && preimage) {
                paths.push({
                    leaf: script.claim(),
                    extraWitness: [hex.decode(preimage)],
                });
            }
            if (role === "sender" && isCltvSatisfied(context, refundLocktime)) {
                paths.push({
                    leaf: script.refundWithoutReceiver(),
                });
            }
            return paths;
        }

        if (role === "receiver" && preimage) {
            const sequence = Number(contract.params.claimDelay);
            if (isCsvSpendable(context, sequence)) {
                paths.push({
                    leaf: script.unilateralClaim(),
                    extraWitness: [hex.decode(preimage)],
                    sequence,
                });
            }
        }
        if (role === "sender") {
            const sequence = Number(contract.params.refundNoReceiverDelay);
            if (isCsvSpendable(context, sequence)) {
                paths.push({
                    leaf: script.unilateralRefundWithoutReceiver(),
                    sequence,
                });
            }
        }

        return paths;
    },
};
