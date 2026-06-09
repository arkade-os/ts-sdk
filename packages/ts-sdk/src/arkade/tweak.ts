/**
 * Arkade Script Tweak
 *
 * Computes the tweaked public key for Arkade scripts.
 * The tweak is: tweakedPubKey = P + taggedHash("ArkScriptHash", script) * G
 *
 * This is NOT taproot tweaking — it's a simple EC point addition used by
 * the emulator service to bind a script to a signing key.
 */

import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";

const TAG_SCRIPT = "ArkScriptHash";
const TAG_WITNESS = "ArkWitnessHash";

/**
 * Compute the tagged hash of an Arkade script.
 * Uses BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || script)
 *
 * @param script - The raw Arkade script bytes
 * @returns 32-byte hash
 */
export function arkadeScriptHash(script: Uint8Array): Uint8Array {
    return schnorr.utils.taggedHash(TAG_SCRIPT, script);
}

/**
 * Compute the tagged hash of an Arkade witness.
 * Uses BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || witness)
 *
 * @param witness - The raw Arkade witness bytes
 * @returns 32-byte hash, or 32 zero bytes if witness is empty
 */
export function arkadeWitnessHash(witness: Uint8Array): Uint8Array {
    if (witness.length === 0) {
        return new Uint8Array(32);
    }
    return schnorr.utils.taggedHash(TAG_WITNESS, witness);
}

/**
 * Compute the Arkade script tweaked public key.
 * result = pubKey + taggedHash("ArkScriptHash", script) * G
 *
 * The input pubKey should be a compressed (33-byte) or x-only (32-byte) public key.
 * Returns a 32-byte x-only public key.
 *
 * @param pubKey - The emulator's base public key (32 or 33 bytes)
 * @param script - The raw Arkade script bytes
 * @returns 32-byte x-only tweaked public key
 */
export function computeArkadeScriptPublicKey(pubKey: Uint8Array, script: Uint8Array): Uint8Array {
    const hash = arkadeScriptHash(script);

    const xOnly = pubKey.length === 33 ? pubKey.subarray(1) : pubKey;
    // Force the even-Y ("02") interpretation of the x-only key. This mirrors the
    // emulator, which lifts its key to even Y (BIP-340 lift_x) before tweaking;
    // we must derive the tweaked pubkey from the same point or it won't match the
    // key the emulator signs with. Prepending the prefix also lets `fromHex`
    // accept both 32-byte (x-only) and 33-byte (compressed) inputs uniformly.
    const point = secp256k1.Point.fromHex("02" + hex.encode(xOnly));

    // tweakPoint = hash * G (reduce modulo curve order n)
    const scalar = bytesToBigInt(hash) % secp256k1.Point.CURVE().n || 1n;
    const tweakPoint = secp256k1.Point.BASE.multiply(scalar);

    // result = point + tweakPoint
    const result = point.add(tweakPoint);

    // Return x-only (32-byte) representation
    return result.toBytes().subarray(1);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
    let result = 0n;
    for (const byte of bytes) {
        result = (result << 8n) | BigInt(byte);
    }
    return result;
}
