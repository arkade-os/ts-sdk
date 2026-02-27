import {
    p2tr,
    p2wpkh,
    Address,
    OutScript,
    RawWitness,
    SigHash,
} from "@scure/btc-signer";
import {
    type BTC_NETWORK,
    concatBytes,
    hash160,
    sha256x2,
} from "@scure/btc-signer/utils.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { equalBytes } from "@noble/curves/utils.js";
import { base64 } from "@scure/base";
import type { Identity } from "../identity";
import { Transaction } from "../utils/transaction";
import { craftToSpendTx, OP_RETURN_EMPTY_PKSCRIPT } from "../intent";

const TAG_BIP322 = "BIP0322-signed-message";

/**
 * BIP-322 simple message signing and verification.
 *
 * Supports P2TR (Taproot) signing and verification, P2WPKH verification,
 * and legacy P2PKH verification (Bitcoin Core signmessage format).
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
     * Verify a BIP-322 signature for a P2TR, P2WPKH, or legacy P2PKH address.
     *
     * For segwit addresses (P2TR, P2WPKH), reconstructs the BIP-322
     * toSpend/toSign transactions and verifies the witness signature.
     *
     * For P2PKH addresses, verifies using the Bitcoin Core legacy
     * `signmessage` format (compact recoverable ECDSA signature).
     *
     * @param message - The original message that was signed
     * @param signature - Base64-encoded signature (BIP-322 witness or legacy compact)
     * @param address - P2TR, P2WPKH, or P2PKH address of the signer
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

        try {
            decoded = Address(network).decode(address);
        } catch {
            return false;
        }

        // Legacy P2PKH: signature is base64 of 65 raw bytes, not a witness
        if (decoded.type === "pkh") {
            try {
                return verifyLegacy(
                    message,
                    base64.decode(signature),
                    decoded.hash
                );
            } catch {
                return false;
            }
        }

        // BIP-322 simple: signature is base64 of RawWitness
        let pkScript;
        let witnessItems;

        try {
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
    // P2TR key-spend witness is exactly [schnorr_signature].
    // Multiple items indicates a script-path spend, which BIP-322 simple doesn't cover.
    if (witnessItems.length !== 1) {
        return false;
    }
    const sig = witnessItems[0];
    if (sig.length !== 64 && sig.length !== 65) {
        return false;
    }

    // BIP-322 simple only allows SIGHASH_DEFAULT (64-byte sig) or SIGHASH_ALL (0x01).
    const sighashType = sig.length === 65 ? sig[64] : SigHash.DEFAULT;
    if (sighashType !== SigHash.DEFAULT && sighashType !== SigHash.ALL) {
        return false;
    }

    const toSpend = craftToSpendTx(message, pkScript, TAG_BIP322);
    const toSign = craftBIP322ToSignP2TR(toSpend, pkScript, pubkey);

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
    if (!equalBytes(derived.hash, addressHash)) {
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

/**
 * Verify a legacy Bitcoin Core signmessage signature for a P2PKH address.
 *
 * The signature is 65 bytes: [recovery_flag, r(32), s(32)].
 * The recovery flag encodes both the recovery ID and whether the key is
 * compressed: flag = 27 + recovery_id (+ 4 if compressed).
 */
function verifyLegacy(
    message: string,
    sigBytes: Uint8Array,
    addressHash: Uint8Array
): boolean {
    if (sigBytes.length !== 65) {
        return false;
    }

    const flag = sigBytes[0];
    if (flag < 27 || flag > 34) {
        return false;
    }

    const compressed = flag >= 31;
    const recoveryId = compressed ? flag - 31 : flag - 27;

    const compactSig = sigBytes.subarray(1, 65);
    const msgHash = bitcoinMessageHash(message);

    try {
        const sig = secp256k1.Signature.fromBytes(
            compactSig,
            "compact"
        ).addRecoveryBit(recoveryId);
        const point = sig.recoverPublicKey(msgHash);
        const pubkeyBytes = point.toBytes(compressed);

        return equalBytes(hash160(pubkeyBytes), addressHash);
    } catch {
        return false;
    }
}

/**
 * Compute the Bitcoin message hash: SHA256d(magic_prefix + CompactSize(len) + message).
 */
function bitcoinMessageHash(message: string): Uint8Array {
    const MAGIC = new TextEncoder().encode("\x18Bitcoin Signed Message:\n");
    const msgBytes = new TextEncoder().encode(message);
    return sha256x2(
        concatBytes(MAGIC, encodeCompactSize(msgBytes.length), msgBytes)
    );
}

function encodeCompactSize(n: number): Uint8Array {
    if (n < 253) return new Uint8Array([n]);
    if (n <= 0xffff) {
        const buf = new Uint8Array(3);
        buf[0] = 253;
        buf[1] = n & 0xff;
        buf[2] = (n >> 8) & 0xff;
        return buf;
    }
    const buf = new Uint8Array(5);
    buf[0] = 254;
    buf[1] = n & 0xff;
    buf[2] = (n >> 8) & 0xff;
    buf[3] = (n >> 16) & 0xff;
    buf[4] = (n >> 24) & 0xff;
    return buf;
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
