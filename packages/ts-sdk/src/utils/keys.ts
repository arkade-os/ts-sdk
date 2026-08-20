/**
 * Normalize a secp256k1 public key to the 32-byte x-only form every tapscript,
 * covenant param and `params.serverPubKey` in this SDK is denominated in.
 *
 * A compressed key drops its parity prefix; an x-only key passes through. Both
 * arrive over the same wires — arkd advertises `signerPubkey` either way,
 * `Identity.xOnlyPublicKey` implementations vary, and solver-supplied fields
 * are whatever the peer sent — so the caller usually cannot know which it
 * holds. Anything else is refused rather than silently truncated: a 65-byte
 * uncompressed key, stripped of one byte, yields a plausible 32-byte value
 * that is not the key, which surfaces as an address nobody funded.
 *
 * The result may alias `key` rather than copy it; callers that mutate their
 * input must copy first.
 *
 * @param key - 32-byte x-only or 33-byte compressed public key
 * @param label - Name used in the error, e.g. `"ark signer key"`
 * @see toXOnlySignerHex for the hex-in, hex-out signer-rotation equivalent
 */
export function toXOnly(key: Uint8Array, label = "public key"): Uint8Array {
    if (key.length === 32) return key;
    if (key.length === 33 && (key[0] === 0x02 || key[0] === 0x03)) return key.subarray(1);
    throw new Error(`${label} is not a compressed or x-only public key`);
}
