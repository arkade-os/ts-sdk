import { Script } from "@scure/btc-signer";
import { Bytes } from "@scure/btc-signer/utils";
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

/**
 * Virtual Hash Time Lock Contract (VHTLC) implementation.
 *
 * VHTLC is a contract that enables atomic swaps and conditional payments
 * in the Ark protocol. It provides multiple spending paths:
 *
 * - **claim**: Receiver can claim funds by revealing the preimage
 * - **refund**: Sender and receiver can collaboratively refund
 * - **refundWithoutReceiver**: Sender can refund after locktime expires
 * - **unilateralClaim**: Receiver can claim unilaterally after delay
 * - **unilateralRefund**: Sender and receiver can refund unilaterally after delay
 * - **unilateralRefundWithoutReceiver**: Sender can refund unilaterally after delay
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
    }

    export class Script extends VtxoScript {
        readonly claimScript: string;
        readonly refundScript: string;
        readonly refundWithoutReceiverScript: string;
        readonly unilateralClaimScript: string;
        readonly unilateralRefundScript: string;
        readonly unilateralRefundWithoutReceiverScript: string;

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

            const unilateralRefundWithoutReceiverScript =
                CSVMultisigTapscript.encode({
                    timelock: unilateralRefundWithoutReceiverDelay,
                    pubkeys: [sender],
                }).script;

            super([
                claimScript,
                refundScript,
                refundWithoutReceiverScript,
                unilateralClaimScript,
                unilateralRefundScript,
                unilateralRefundWithoutReceiverScript,
            ]);

            this.claimScript = hex.encode(claimScript);
            this.refundScript = hex.encode(refundScript);
            this.refundWithoutReceiverScript = hex.encode(
                refundWithoutReceiverScript
            );
            this.unilateralClaimScript = hex.encode(unilateralClaimScript);
            this.unilateralRefundScript = hex.encode(unilateralRefundScript);
            this.unilateralRefundWithoutReceiverScript = hex.encode(
                unilateralRefundWithoutReceiverScript
            );
        }

        claim(): TapLeafScript {
            return this.findLeaf(this.claimScript);
        }

        refund(): TapLeafScript {
            return this.findLeaf(this.refundScript);
        }

        refundWithoutReceiver(): TapLeafScript {
            return this.findLeaf(this.refundWithoutReceiverScript);
        }

        unilateralClaim(): TapLeafScript {
            return this.findLeaf(this.unilateralClaimScript);
        }

        unilateralRefund(): TapLeafScript {
            return this.findLeaf(this.unilateralRefundScript);
        }

        unilateralRefundWithoutReceiver(): TapLeafScript {
            return this.findLeaf(this.unilateralRefundWithoutReceiverScript);
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
        if (
            unilateralClaimDelay.type === "seconds" &&
            unilateralClaimDelay.value % 512n !== 0n
        ) {
            throw new Error("seconds timelock must be multiple of 512");
        }
        if (
            unilateralClaimDelay.type === "seconds" &&
            unilateralClaimDelay.value < 512n
        ) {
            throw new Error("seconds timelock must be greater or equal to 512");
        }
        if (
            !unilateralRefundDelay ||
            typeof unilateralRefundDelay.value !== "bigint" ||
            unilateralRefundDelay.value <= 0n
        ) {
            throw new Error("unilateral refund delay must greater than 0");
        }
        if (
            unilateralRefundDelay.type === "seconds" &&
            unilateralRefundDelay.value % 512n !== 0n
        ) {
            throw new Error("seconds timelock must be multiple of 512");
        }
        if (
            unilateralRefundDelay.type === "seconds" &&
            unilateralRefundDelay.value < 512n
        ) {
            throw new Error("seconds timelock must be greater or equal to 512");
        }
        if (
            !unilateralRefundWithoutReceiverDelay ||
            typeof unilateralRefundWithoutReceiverDelay.value !== "bigint" ||
            unilateralRefundWithoutReceiverDelay.value <= 0n
        ) {
            throw new Error(
                "unilateral refund without receiver delay must greater than 0"
            );
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
