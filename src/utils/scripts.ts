import { hex } from "@scure/base";
import { normalizeToXOnlyPublicKey } from "./keys";
import { VHTLC } from "@arkade-os/sdk";
import { ripemd160 } from "@noble/hashes/legacy.js";

/**
 * Creates a VHTLC script for the swap.
 * works for submarine swaps and reverse swaps
 * it creates a VHTLC script that can be used to claim or refund the swap
 * it validates the receiver, sender and server public keys are x-only
 * it validates the VHTLC script matches the expected lockup address
 *
 * @param options - The parameters for creating the VHTLC script.
 * @returns The created VHTLC script.
 * @throws if public keys aren't X-Only
 */
export function createVHTLCScript({
    network,
    preimageHash,
    receiverPubkey,
    senderPubkey,
    serverPubkey,
    timeoutBlockHeights,
}: {
    network: string;
    preimageHash: Uint8Array;
    receiverPubkey: string;
    senderPubkey: string;
    serverPubkey: string;
    timeoutBlockHeights: {
        refund: number;
        unilateralClaim: number;
        unilateralRefund: number;
        unilateralRefundWithoutReceiver: number;
    };
}): { vhtlcScript: VHTLC.Script; vhtlcAddress: string } {
    // validate we are using a x-only receiver public key
    const receiverXOnlyPublicKey = normalizeToXOnlyPublicKey(
        hex.decode(receiverPubkey),
        "receiver"
    );

    // validate we are using a x-only sender public key
    const senderXOnlyPublicKey = normalizeToXOnlyPublicKey(
        hex.decode(senderPubkey),
        "sender"
    );

    // validate we are using a x-only server public key
    const serverXOnlyPublicKey = normalizeToXOnlyPublicKey(
        hex.decode(serverPubkey),
        "server"
    );

    const delayType = (num: number) => (num < 512 ? "blocks" : "seconds");

    const vhtlcScript = new VHTLC.Script({
        preimageHash: ripemd160(preimageHash),
        sender: senderXOnlyPublicKey,
        receiver: receiverXOnlyPublicKey,
        server: serverXOnlyPublicKey,
        refundLocktime: BigInt(timeoutBlockHeights.refund),
        unilateralClaimDelay: {
            type: delayType(timeoutBlockHeights.unilateralClaim),
            value: BigInt(timeoutBlockHeights.unilateralClaim),
        },
        unilateralRefundDelay: {
            type: delayType(timeoutBlockHeights.unilateralRefund),
            value: BigInt(timeoutBlockHeights.unilateralRefund),
        },
        unilateralRefundWithoutReceiverDelay: {
            type: delayType(
                timeoutBlockHeights.unilateralRefundWithoutReceiver
            ),
            value: BigInt(timeoutBlockHeights.unilateralRefundWithoutReceiver),
        },
    });

    if (!vhtlcScript) throw new Error("Failed to create VHTLC script");

    // validate vhtlc script
    const hrp = network === "bitcoin" ? "ark" : "tark";
    const vhtlcAddress = vhtlcScript
        .address(hrp, serverXOnlyPublicKey)
        .encode();

    return { vhtlcScript, vhtlcAddress };
}
