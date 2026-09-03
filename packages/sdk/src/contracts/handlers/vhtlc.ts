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
import { assertVhtlcSpendableNow, isCltvSatisfied, isCsvSpendable, resolveRole } from "./helpers";
import { sequenceToTimelock, timelockToSequence } from "../../utils/timelock";

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

    /**
     * Refuse an explicit spend of a lockup whose refund path has not opened.
     * Shared with the v2 handler so the two cannot drift.
     * @see assertVhtlcSpendableNow for why this is the one certain case.
     */
    assertSpendableNow(_script: VHTLC.Script, contract: Contract, context: PathContext): void {
        assertVhtlcSpendableNow(contract, context);
    },

    /**
     * Never. A live VHTLC is escrow: the counterparty's claim leaf is armed,
     * and generic selection — send, settle, renewal, offboard — would move the
     * lockup out from under a swap the counterparty is still entitled to
     * complete, or race a claim already in flight.
     *
     * Two narrow reasons, and neither is "spending this would destroy the
     * VTXO". It would not: the leaf {@link deriveTapscripts} stamps is
     * `refundWithoutReceiver` — `CLTV[sender, server]`, the sender's OWN
     * refund, which the server rejects until `refundLocktime` matures. The
     * reasons are that an escrowed lockup must not count toward the
     * `available` balance bucket, and that generic RENEWAL must not silently
     * execute a refund the caller never asked for — `runPeriodicSettle` selects
     * through `getSpendableVtxos`, which this gate filters, and it runs
     * unprompted whenever a wallet is built without an explicit
     * `settlementConfig`.
     *
     * **Inseparable from {@link deriveTapscripts}.** Deriving the leaf without
     * closing the gate hands generic renewal an escrow it had never been
     * offered before; before that method existed the answer here was
     * unobservable, so the two only ever made sense together.
     *
     * Recovery is filtered on {@link assertSpendableNow}, not on this: the gate
     * is permanent, and applying it there would strand a matured lockup.
     */
    isGenericallySpendable: () => false,

    /**
     * The annotation leaf stamped onto every VTXO locked to this contract.
     *
     * **Without this the contract is unusable, not merely unoptimized.**
     * `deriveContractTapscripts` falls back to `script.forfeit()` for any
     * handler that does not implement {@link TapscriptDeriving}, and no VHTLC
     * script version has a `forfeit()` — `VtxoScript` does not define one and
     * `VHTLC.BaseScript` does not add one. The fallback therefore threw
     * `legacy.forfeit is not a function`, `annotatableIn` caught it, and
     * `fetchContractVtxosBulk` dropped this contract's VTXOs before they were
     * persisted. The row existed and was watched while its balance stayed
     * permanently invisible, and `getSyncState()` reported `degraded` forever.
     *
     * `refundWithoutReceiver` is the leaf, for both roles the annotation
     * serves, because it is the only collaborative path this wallet can
     * actually satisfy as the sender — the same conclusion `selectPath`
     * reaches, kept in step with it deliberately. The claim leaves belong to
     * the receiver and need a preimage the sender does not have; `refund` and
     * `unilateralRefund` both need the counterparty's signature, which this
     * protocol has no message to ask for. V1 has no covenant leaves at all.
     *
     * **It carries a CLTV, and callers must respect it.** A settlement built
     * on this leaf is only valid once `refundLocktime` has matured, so a
     * recovery round that sweeps this VTXO early is rejected by the server.
     * Nothing in this handler can enforce that, because the annotation is
     * derived per contract and knows no clock; `recoverVtxos` filters on
     * {@link assertSpendableNow} for it.
     *
     * **Role-blind.** A receiver's row gets the same leaf, which names keys that
     * wallet does not hold, so it is satisfiable only by the wallet holding the
     * lockup's `sender` key and fails at intent registration for anyone else.
     */
    deriveTapscripts(script: VHTLC.Script): DerivedContractTapscripts {
        const leaf = script.refundWithoutReceiver();
        return {
            forfeitTapLeafScript: leaf,
            intentTapLeafScript: leaf,
            tapTree: script.encode(),
        };
    },
};
