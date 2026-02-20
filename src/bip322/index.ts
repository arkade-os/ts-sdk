import {
    p2tr,
    Address,
    OutScript,
    RawWitness,
    SigHash,
} from "@scure/btc-signer";
import type { BTC_NETWORK } from "@scure/btc-signer/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { base64 } from "@scure/base";
import type { Identity } from "../identity";
import { Transaction } from "../utils/transaction";
import { craftToSpendTx, OP_RETURN_EMPTY_PKSCRIPT } from "../intent";

const TAG_BIP322 = "BIP0322-signed-message";

/**
 * BIP-322 simple message signing and verification for P2TR (Taproot) addresses.
 *
 * Reuses the same toSpend/toSign transaction construction as Intent proofs,
 * but with the standard BIP-322 tagged hash ("BIP0322-signed-message")
 * instead of the Ark-specific tag.
 *
 * @see https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki
 *
 * @example
 * ```typescript
 * // Sign a message
 * const signature = await BIP322.sign("Hello Bitcoin!", identity);
 *
 * // Verify a signature
 * const valid = BIP322.verify("Hello Bitcoin!", signature, "bc1p...");
 * ```
 */
export namespace BIP322 {
    /**
     * Sign a message using the BIP-322 simple signature scheme.
     *
     * Constructs the standard BIP-322 toSpend and toSign transactions,
     * signs via the Identity interface, and returns the base64-encoded
     * witness stack.
     *
     * @param message - The message to sign
     * @param identity - Identity instance (holds the private key internally)
     * @param network - Optional Bitcoin network for P2TR address derivation
     * @returns Base64-encoded BIP-322 simple signature (witness stack)
     */
    export async function sign(
        message: string,
        identity: Identity,
        network?: BTC_NETWORK
    ): Promise<string> {
        const xOnlyPubKey = await identity.xOnlyPublicKey();
        const payment = p2tr(xOnlyPubKey, undefined, network);

        // Build BIP-322 toSpend using shared construction with BIP-322 tag
        const toSpend = craftToSpendTx(message, payment.script, TAG_BIP322);

        // Build BIP-322 toSign: version 0, single input spending toSpend, OP_RETURN output
        const toSign = craftBIP322ToSign(toSpend, payment.script, xOnlyPubKey);

        // Sign with identity (handles P2TR key-spend internally)
        const signed = await identity.sign(toSign, [0]);

        // Finalize and extract witness
        signed.finalizeIdx(0);
        const input = signed.getInput(0);
        if (!input.finalScriptWitness) {
            throw new Error("BIP-322: failed to produce witness after signing");
        }

        return base64.encode(RawWitness.encode(input.finalScriptWitness));
    }

    /**
     * Verify a BIP-322 simple signature for a P2TR address.
     *
     * Reconstructs the toSpend and toSign transactions from the message
     * and address, then verifies the schnorr signature from the witness
     * against the computed sighash.
     *
     * @param message - The original message that was signed
     * @param signature - Base64-encoded BIP-322 simple signature
     * @param address - P2TR bech32m address of the signer
     * @param network - Optional Bitcoin network for address decoding
     * @returns true if the signature is valid
     */
    export function verify(
        message: string,
        signature: string,
        address: string,
        network?: BTC_NETWORK
    ): boolean {
        // Decode the address to get the x-only public key and script
        const decoded = Address(network).decode(address);
        if (decoded.type !== "tr") {
            throw new Error(
                "BIP-322 verify: only P2TR addresses are supported"
            );
        }
        const pubkey = decoded.pubkey;
        const pkScript = OutScript.encode(decoded);

        // Decode the witness
        const witnessItems = RawWitness.decode(base64.decode(signature));
        if (witnessItems.length === 0) {
            return false;
        }

        // For P2TR key-spend, witness is [schnorr_signature]
        // Signature can be 64 bytes (SIGHASH_DEFAULT) or 65 bytes (explicit sighash)
        const sig = witnessItems[0];
        if (sig.length !== 64 && sig.length !== 65) {
            return false;
        }

        // Reconstruct the toSpend and toSign to compute the expected sighash
        const toSpend = craftToSpendTx(message, pkScript, TAG_BIP322);
        const toSign = craftBIP322ToSign(toSpend, pkScript, pubkey);

        // Compute the taproot key-spend sighash (BIP-341 witness v1)
        const sighashType = sig.length === 65 ? sig[64] : SigHash.DEFAULT;
        const sighash = toSign.preimageWitnessV1(0, [pkScript], sighashType, [
            0n,
        ]);

        // Verify the schnorr signature
        const rawSig = sig.length === 65 ? sig.subarray(0, 64) : sig;
        return schnorr.verify(rawSig, sighash, pubkey);
    }
}

/**
 * Build the BIP-322 "toSign" transaction.
 *
 * Per the BIP-322 spec: version 0, nLockTime 0, single input
 * spending the toSpend output, single OP_RETURN output.
 */
function craftBIP322ToSign(
    toSpend: Transaction,
    pkScript: Uint8Array,
    tapInternalKey: Uint8Array
): Transaction {
    const tx = new Transaction({ version: 0 });

    tx.addInput({
        txid: toSpend.id,
        index: 0,
        sequence: 0,
        witnessUtxo: {
            script: pkScript,
            amount: 0n,
        },
        tapInternalKey,
        sighashType: SigHash.DEFAULT,
    });

    tx.addOutput({
        amount: 0n,
        script: OP_RETURN_EMPTY_PKSCRIPT,
    });

    return tx;
}
