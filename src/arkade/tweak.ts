/**
 * Arkade Script Tweak
 *
 * Computes the tweaked public key for Arkade scripts.
 * The tweak is: tweakedPubKey = P + taggedHash("ArkScriptHash", script) * G
 *
 * This is NOT taproot tweaking — it's a simple EC point addition used by
 * the introspector service to bind a script to a signing key.
 */

import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";

const TAG = "ArkScriptHash";

/**
 * Compute the tagged hash of an Arkade script.
 * Uses BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || script)
 *
 * @param script - The raw Arkade script bytes
 * @returns 32-byte hash
 */
export function arkadeScriptHash(script: Uint8Array): Uint8Array {
    return schnorr.utils.taggedHash(TAG, script);
}

/**
 * Compute the Arkade script tweaked public key.
 * result = pubKey + taggedHash("ArkScriptHash", script) * G
 *
 * The input pubKey should be a compressed (33-byte) or x-only (32-byte) public key.
 * Returns a 32-byte x-only public key.
 *
 * @param pubKey - The introspector's base public key (32 or 33 bytes)
 * @param script - The raw Arkade script bytes
 * @returns 32-byte x-only tweaked public key
 */
export function computeArkadeScriptPublicKey(
    pubKey: Uint8Array,
    script: Uint8Array
): Uint8Array {
    const hash = arkadeScriptHash(script);

    // lift_x: always force even Y (BIP-340 convention).
    // This matches the Go introspector's behavior which does:
    //   schnorr.ParsePubKey(schnorr.SerializePubKey(pubKey))
    // i.e. round-trips through x-only, forcing even Y regardless of input.
    const xOnly = pubKey.length === 33 ? pubKey.subarray(1) : pubKey;
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
