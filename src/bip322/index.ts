import {
    p2tr,
    p2wpkh,
    Address,
    OutScript,
    RawWitness,
    SigHash,
} from "@scure/btc-signer";
import type { BTC_NETWORK } from "@scure/btc-signer/utils.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { base64 } from "@scure/base";
import type { Identity } from "../identity";
import { Transaction } from "../utils/transaction";
import { craftToSpendTx, OP_RETURN_EMPTY_PKSCRIPT } from "../intent";

const TAG_BIP322 = "BIP0322-signed-message";

/**
 * BIP-322 simple message signing and verification.
 *
 * Supports P2TR (Taproot) signing and verification, and P2WPKH verification.
 *
 * Reuses the same toSpend/toSign transaction construction as Intent proofs,
 * but with the standard BIP-322 tagged hash ("BIP0322-signed-message")
 * instead of the Ark-specific tag.
 *
 * @see https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki
 *
 * @example
 * ```typescript
 * // Sign a message (P2TR)
 * const signature = await BIP322.sign("Hello Bitcoin!", identity);
 *
 * // Verify a signature (P2TR or P2WPKH)
 * const valid = BIP322.verify("Hello Bitcoin!", signature, "bc1p...");
 * const valid2 = BIP322.verify("Hello Bitcoin!", signature, "bc1q...");
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
        const toSign = craftBIP322ToSignP2TR(
            toSpend,
            payment.script,
            xOnlyPubKey
        );

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
     * Verify a BIP-322 simple signature for a P2TR or P2WPKH address.
     *
     * Reconstructs the toSpend and toSign transactions from the message
     * and address, then verifies the signature from the witness against
     * the computed sighash.
     *
     * @param message - The original message that was signed
     * @param signature - Base64-encoded BIP-322 simple signature
     * @param address - P2TR (bc1p...) or P2WPKH (bc1q...) address of the signer
     * @param network - Optional Bitcoin network for address decoding
     * @returns true if the signature is valid
     */
    export function verify(
        message: string,
        signature: string,
        address: string,
        network?: BTC_NETWORK
    ): boolean {
        let decoded;
        let pkScript;
        let witnessItems;

        try {
            decoded = Address(network).decode(address);
            pkScript = OutScript.encode(decoded);
            witnessItems = RawWitness.decode(base64.decode(signature));
        } catch {
            return false;
        }

        if (witnessItems.length === 0) {
            return false;
        }

        if (decoded.type === "tr") {
            return verifyP2TR(message, witnessItems, pkScript, decoded.pubkey);
        }
        if (decoded.type === "wpkh") {
            return verifyP2WPKH(message, witnessItems, pkScript, decoded.hash);
        }

        throw new Error(
            `BIP-322 verify: unsupported address type '${decoded.type}'`
        );
    }
}

function verifyP2TR(
    message: string,
    witnessItems: Uint8Array[],
    pkScript: Uint8Array,
    pubkey: Uint8Array
): boolean {
    // For P2TR key-spend, witness is [schnorr_signature]
    // Signature can be 64 bytes (SIGHASH_DEFAULT) or 65 bytes (explicit sighash)
    const sig = witnessItems[0];
    if (sig.length !== 64 && sig.length !== 65) {
        return false;
    }

    const toSpend = craftToSpendTx(message, pkScript, TAG_BIP322);
    const toSign = craftBIP322ToSignP2TR(toSpend, pkScript, pubkey);

    const sighashType = sig.length === 65 ? sig[64] : SigHash.DEFAULT;
    const sighash = toSign.preimageWitnessV1(0, [pkScript], sighashType, [0n]);

    const rawSig = sig.length === 65 ? sig.subarray(0, 64) : sig;
    return schnorr.verify(rawSig, sighash, pubkey);
}

function verifyP2WPKH(
    message: string,
    witnessItems: Uint8Array[],
    pkScript: Uint8Array,
    addressHash: Uint8Array
): boolean {
    // P2WPKH witness: [der_signature || sighash_byte, compressed_pubkey]
    if (witnessItems.length !== 2) {
        return false;
    }

    const sigWithHash = witnessItems[0];
    const pubkey = witnessItems[1];

    if (pubkey.length !== 33 || sigWithHash.length < 2) {
        return false;
    }

    // Verify the pubkey matches the address hash
    const derived = p2wpkh(pubkey);
    if (!bytesEqual(derived.hash, addressHash)) {
        return false;
    }

    // Extract sighash type (last byte) and DER signature
    const sighashType = sigWithHash[sigWithHash.length - 1];
    const derSig = sigWithHash.subarray(0, sigWithHash.length - 1);

    // Build toSpend and toSign
    const toSpend = craftToSpendTx(message, pkScript, TAG_BIP322);
    const toSign = craftBIP322ToSignSimple(toSpend, pkScript);

    // BIP-143 scriptCode for P2WPKH: equivalent P2PKH script
    const scriptCode = OutScript.encode({ type: "pkh", hash: addressHash });
    const sighash = toSign.preimageWitnessV0(0, scriptCode, sighashType, 0n);

    return secp256k1.verify(derSig, sighash, pubkey, {
        prehash: false,
        format: "der",
    });
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Build the BIP-322 "toSign" transaction for P2TR key-spend.
 */
function craftBIP322ToSignP2TR(
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

/**
 * Build the BIP-322 "toSign" transaction (generic, no key metadata).
 *
 * Used for P2WPKH verification where the toSign only needs
 * the witnessUtxo, not tapInternalKey.
 */
function craftBIP322ToSignSimple(
    toSpend: Transaction,
    pkScript: Uint8Array
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
    });

    tx.addOutput({
        amount: 0n,
        script: OP_RETURN_EMPTY_PKSCRIPT,
    });

    return tx;
}
