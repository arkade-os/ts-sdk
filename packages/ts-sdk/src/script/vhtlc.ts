import { Script } from "@scure/btc-signer";
import { Bytes } from "@scure/btc-signer/utils.js";
import {
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    MultisigTapscript,
    RelativeTimelock,
} from "./tapscript";
import { hex } from "@scure/base";
import { TapLeafScript, VtxoScript } from "./base";
import { ArkadeScript } from "../arkade/script";
import { computeArkadeScriptPublicKey } from "../arkade/tweak";

/** Virtual Hash Time Lock Contract (VHTLC) namespace. */
export namespace VHTLC {
    export interface Options {
        sender: Bytes;
        receiver: Bytes;
        server: Bytes;
        preimageHash: Bytes;
        refundLocktime: bigint;
        unilateralClaimDelay: RelativeTimelock;
        unilateralRefundDelay: RelativeTimelock;
        unilateralRefundWithoutReceiverDelay: RelativeTimelock;
        /**
         * Optional non-interactive claim leaf: `server` plus a covenant-tweaked
         * emulator co-signer, pinned to `receiverPkScript`. Lets the receiver's
         * claim be pushed by the emulator without the receiver being online.
         */
        nonInteractiveClaim?: {
            receiverPkScript: Bytes;
            emulatorPubkey: Bytes;
        };
        /**
         * Optional non-interactive refund leaf: `server` + `receiver` + a
         * covenant-tweaked emulator co-signer, pinned to `senderPkScript`, no
         * timelock. Every OTHER refund-side leaf in this contract requires
         * the sender's own signature — if the sender permanently loses that
         * key, none of them are reachable. This leaf is the one exception:
         * it needs neither the sender's presence nor their key, so funds
         * remain recoverable to the sender's pre-committed address even
         * then. It still needs the receiver (unlike `nonInteractiveClaim`,
         * which needs only server + emulator) — deliberately: this is what
         * lets server + receiver release the refund immediately, the moment
         * they agree the swap has failed, rather than making the sender wait
         * out `refundLocktime` the way {@link Script.refundWithoutReceiver}
         * does.
         */
        nonInteractiveRefund?: {
            senderPkScript: Bytes;
            emulatorPubkey: Bytes;
        };
    }

    /**
     * Virtual Hash Time Lock Contract (VHTLC) script implementation.
     *
     * VHTLC enables atomic swaps and conditional payments in the Arkade protocol.
     * It provides multiple spending paths:
     *
     * - **claim**: Receiver can claim funds by revealing the preimage
     * - **refund**: Sender and receiver can collaboratively refund
     * - **refundWithoutReceiver**: Sender can refund after locktime expires
     * - **unilateralClaim**: Receiver can claim unilaterally after delay
     * - **unilateralRefund**: Sender and receiver can refund unilaterally after delay
     * - **unilateralRefundWithoutReceiver**: Sender can refund unilaterally after delay
     * - **nonInteractiveClaim** (optional): server + emulator can push the
     *   receiver's claim, pinned to a pre-committed destination
     * - **nonInteractiveRefund** (optional): server + receiver + emulator
     *   can push the sender's refund immediately, no timelock, pinned to a
     *   pre-committed destination — recoverable even if the sender's own key
     *   is lost
     *
     * @example
     * ```typescript
     * const vhtlc = new VHTLC.Script({
     *   sender: alicePubKey,
     *   receiver: bobPubKey,
     *   server: serverPubKey,
     *   preimageHash: hash160(secret),
     *   refundLocktime: BigInt(chainTip + 10),
     *   unilateralClaimDelay: { type: 'blocks', value: 100n },
     *   unilateralRefundDelay: { type: 'blocks', value: 102n },
     *   unilateralRefundWithoutReceiverDelay: { type: 'blocks', value: 103n }
     * });
     * ```
     */
    export class Script extends VtxoScript {
        readonly claimScript: string;
        readonly refundScript: string;
        readonly refundWithoutReceiverScript: string;
        readonly unilateralClaimScript: string;
        readonly unilateralRefundScript: string;
        readonly unilateralRefundWithoutReceiverScript: string;
        readonly nonInteractiveClaimScript?: string;
        readonly nonInteractiveClaimArkadeScript?: Bytes;
        readonly nonInteractiveRefundScript?: string;
        readonly nonInteractiveRefundArkadeScript?: Bytes;

        /** Create a VHTLC script from the supplied participant keys, hash, and timelocks. */
        constructor(readonly options: Options) {
            validateOptions(options);

            const {
                sender,
                receiver,
                server,
                preimageHash,
                refundLocktime,
                unilateralClaimDelay,
                unilateralRefundDelay,
                unilateralRefundWithoutReceiverDelay,
            } = options;

            const conditionScript = preimageConditionScript(preimageHash);

            const claimScript = ConditionMultisigTapscript.encode({
                conditionScript,
                pubkeys: [receiver, server],
            }).script;

            const refundScript = MultisigTapscript.encode({
                pubkeys: [sender, receiver, server],
            }).script;

            const refundWithoutReceiverScript = CLTVMultisigTapscript.encode({
                absoluteTimelock: refundLocktime,
                pubkeys: [sender, server],
            }).script;

            const unilateralClaimScript = ConditionCSVMultisigTapscript.encode({
                conditionScript,
                timelock: unilateralClaimDelay,
                pubkeys: [receiver],
            }).script;

            const unilateralRefundScript = CSVMultisigTapscript.encode({
                timelock: unilateralRefundDelay,
                pubkeys: [sender, receiver],
            }).script;

            const unilateralRefundWithoutReceiverScript = CSVMultisigTapscript.encode({
                timelock: unilateralRefundWithoutReceiverDelay,
                pubkeys: [sender],
            }).script;

            const scripts = [
                claimScript,
                refundScript,
                refundWithoutReceiverScript,
                unilateralClaimScript,
                unilateralRefundScript,
                unilateralRefundWithoutReceiverScript,
            ];

            let arkadeScriptNic: Bytes | undefined;
            let nonInteractiveClaimScript: Bytes | undefined;
            if (options.nonInteractiveClaim) {
                arkadeScriptNic = enforcePayTo(options.nonInteractiveClaim.receiverPkScript);
                nonInteractiveClaimScript = ConditionMultisigTapscript.encode({
                    conditionScript,
                    pubkeys: [
                        server,
                        computeArkadeScriptPublicKey(
                            options.nonInteractiveClaim.emulatorPubkey,
                            arkadeScriptNic,
                        ),
                    ],
                }).script;
                scripts.push(nonInteractiveClaimScript);
            }

            let arkadeScriptNir: Bytes | undefined;
            let nonInteractiveRefundScript: Bytes | undefined;
            if (options.nonInteractiveRefund) {
                arkadeScriptNir = enforcePayTo(options.nonInteractiveRefund.senderPkScript);
                // No timelock: server + receiver together can release this
                // immediately, same as `refund` above, just without needing
                // the sender's own signature — the covenant is what still
                // guarantees the payout can only reach the sender.
                nonInteractiveRefundScript = MultisigTapscript.encode({
                    pubkeys: [
                        server,
                        receiver,
                        computeArkadeScriptPublicKey(
                            options.nonInteractiveRefund.emulatorPubkey,
                            arkadeScriptNir,
                        ),
                    ],
                }).script;
                scripts.push(nonInteractiveRefundScript);
            }

            super(scripts);

            this.claimScript = hex.encode(claimScript);
            this.refundScript = hex.encode(refundScript);
            this.refundWithoutReceiverScript = hex.encode(refundWithoutReceiverScript);
            this.unilateralClaimScript = hex.encode(unilateralClaimScript);
            this.unilateralRefundScript = hex.encode(unilateralRefundScript);
            this.unilateralRefundWithoutReceiverScript = hex.encode(
                unilateralRefundWithoutReceiverScript,
            );
            if (nonInteractiveClaimScript) {
                this.nonInteractiveClaimScript = hex.encode(nonInteractiveClaimScript);
                this.nonInteractiveClaimArkadeScript = arkadeScriptNic;
            }
            if (nonInteractiveRefundScript) {
                this.nonInteractiveRefundScript = hex.encode(nonInteractiveRefundScript);
                this.nonInteractiveRefundArkadeScript = arkadeScriptNir;
            }
        }

        /** Return the collaborative claim tapleaf script. */
        claim(): TapLeafScript {
            return this.findLeaf(this.claimScript);
        }

        /** Return the collaborative refund tapleaf script. */
        refund(): TapLeafScript {
            return this.findLeaf(this.refundScript);
        }

        /** Return the refund-without-receiver tapleaf script. */
        refundWithoutReceiver(): TapLeafScript {
            return this.findLeaf(this.refundWithoutReceiverScript);
        }

        /** Return the unilateral claim tapleaf script. */
        unilateralClaim(): TapLeafScript {
            return this.findLeaf(this.unilateralClaimScript);
        }

        /** Return the unilateral refund tapleaf script. */
        unilateralRefund(): TapLeafScript {
            return this.findLeaf(this.unilateralRefundScript);
        }

        /** Return the unilateral refund-without-receiver tapleaf script. */
        unilateralRefundWithoutReceiver(): TapLeafScript {
            return this.findLeaf(this.unilateralRefundWithoutReceiverScript);
        }

        /** Return the non-interactive claim tapleaf script as well as the ArkadeScript. */
        nonInteractiveClaim(): [TapLeafScript, Bytes] {
            if (!this.nonInteractiveClaimScript || !this.nonInteractiveClaimArkadeScript) {
                throw new Error("VHTLC has no non-interactive claim leaf");
            }
            return [
                this.findLeaf(this.nonInteractiveClaimScript),
                this.nonInteractiveClaimArkadeScript,
            ];
        }

        /** Return the non-interactive refund tapleaf script as well as the ArkadeScript. */
        nonInteractiveRefund(): [TapLeafScript, Bytes] {
            if (!this.nonInteractiveRefundScript || !this.nonInteractiveRefundArkadeScript) {
                throw new Error("VHTLC has no non-interactive refund leaf");
            }
            return [
                this.findLeaf(this.nonInteractiveRefundScript),
                this.nonInteractiveRefundArkadeScript,
            ];
        }
    }

    function validateOptions(options: Options): void {
        const {
            sender,
            receiver,
            server,
            preimageHash,
            refundLocktime,
            unilateralClaimDelay,
            unilateralRefundDelay,
            unilateralRefundWithoutReceiverDelay,
        } = options;

        if (!preimageHash || preimageHash.length !== 20) {
            throw new Error("preimage hash must be 20 bytes");
        }
        if (options.nonInteractiveClaim) {
            const { emulatorPubkey, receiverPkScript } = options.nonInteractiveClaim;
            if (!emulatorPubkey || (emulatorPubkey.length !== 32 && emulatorPubkey.length !== 33)) {
                throw new Error("Invalid public key length (emulator)");
            }
            if (receiverPkScript.length !== 34) {
                throw new Error("Invalid P2TR script");
            }
        }
        if (options.nonInteractiveRefund) {
            const { emulatorPubkey, senderPkScript } = options.nonInteractiveRefund;
            if (!emulatorPubkey || (emulatorPubkey.length !== 32 && emulatorPubkey.length !== 33)) {
                throw new Error("Invalid public key length (emulator)");
            }
            if (senderPkScript.length !== 34) {
                throw new Error("Invalid P2TR script");
            }
        }
        if (!receiver || receiver.length !== 32) {
            throw new Error("Invalid public key length (receiver)");
        }
        if (!sender || sender.length !== 32) {
            throw new Error("Invalid public key length (sender)");
        }
        if (!server || server.length !== 32) {
            throw new Error("Invalid public key length (server)");
        }
        if (typeof refundLocktime !== "bigint" || refundLocktime <= 0n) {
            throw new Error("refund locktime must be greater than 0");
        }
        if (
            !unilateralClaimDelay ||
            typeof unilateralClaimDelay.value !== "bigint" ||
            unilateralClaimDelay.value <= 0n
        ) {
            throw new Error("unilateral claim delay must greater than 0");
        }
        if (unilateralClaimDelay.type === "seconds" && unilateralClaimDelay.value % 512n !== 0n) {
            throw new Error("seconds timelock must be multiple of 512");
        }
        if (unilateralClaimDelay.type === "seconds" && unilateralClaimDelay.value < 512n) {
            throw new Error("seconds timelock must be greater or equal to 512");
        }
        if (
            !unilateralRefundDelay ||
            typeof unilateralRefundDelay.value !== "bigint" ||
            unilateralRefundDelay.value <= 0n
        ) {
            throw new Error("unilateral refund delay must greater than 0");
        }
        if (unilateralRefundDelay.type === "seconds" && unilateralRefundDelay.value % 512n !== 0n) {
            throw new Error("seconds timelock must be multiple of 512");
        }
        if (unilateralRefundDelay.type === "seconds" && unilateralRefundDelay.value < 512n) {
            throw new Error("seconds timelock must be greater or equal to 512");
        }
        if (
            !unilateralRefundWithoutReceiverDelay ||
            typeof unilateralRefundWithoutReceiverDelay.value !== "bigint" ||
            unilateralRefundWithoutReceiverDelay.value <= 0n
        ) {
            throw new Error("unilateral refund without receiver delay must greater than 0");
        }
        if (
            unilateralRefundWithoutReceiverDelay.type === "seconds" &&
            unilateralRefundWithoutReceiverDelay.value % 512n !== 0n
        ) {
            throw new Error("seconds timelock must be multiple of 512");
        }
        if (
            unilateralRefundWithoutReceiverDelay.type === "seconds" &&
            unilateralRefundWithoutReceiverDelay.value < 512n
        ) {
            throw new Error("seconds timelock must be greater or equal to 512");
        }
    }
}

function preimageConditionScript(preimageHash: Bytes): Bytes {
    return Script.encode(["HASH160", preimageHash, "EQUAL"]);
}

/**
 * The covenant: "this input's output pays the given P2TR script, value >=
 * input". Shared by {@link VHTLC.Options.nonInteractiveClaim} and {@link
 * VHTLC.Options.nonInteractiveRefund} — only the destination and the tier it
 * gates differ.
 */
function enforcePayTo(destinationPkScript: Bytes): Bytes {
    if (destinationPkScript.length < 34) {
        throw new Error("invalid P2TR script");
    }
    return ArkadeScript.encode([
        "PUSHCURRENTINPUTINDEX",
        "DUP",
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        destinationPkScript.subarray(2),
        "EQUALVERIFY",
        "INSPECTOUTPUTVALUE",
        "PUSHCURRENTINPUTINDEX",
        "INSPECTINPUTVALUE",
        "GREATERTHANOREQUAL",
    ]);
}
