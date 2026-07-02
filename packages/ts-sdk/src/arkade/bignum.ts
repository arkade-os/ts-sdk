/**
 * BigNum — arbitrary-precision sign-magnitude little-endian encoding used by
 * the arkade VM in emulator v0.0.1. Up to 520 bytes (= MaxScriptElementSize).
 *
 * Wire format:
 *   - empty bytes   = 0
 *   - last byte's high bit (0x80) is the sign (set = negative)
 *   - remaining bits are magnitude, little-endian
 *   - minimal: no trailing zero magnitude byte; `[0x80]` (negative zero) is rejected
 *
 * Wraps `@scure/btc-signer`'s `ScriptNum` with a 520-byte cap. Use the
 * standalone API when you need to round-trip values outside of script encoding;
 * inside `ArkadeScript.encode([...])`, plain `bigint` literals work directly.
 */

import { ScriptNum } from "@scure/btc-signer";

/** Maximum number of bytes for a BigNum (= MaxScriptElementSize). */
export const BIGNUM_MAX_BYTES = 520;

const codec = ScriptNum(BIGNUM_MAX_BYTES, /* forceMinimal */ true);

/**
 * Encode `value` as a minimal sign-magnitude little-endian byte string.
 * Throws if the encoding would exceed 520 bytes.
 */
export function encode(value: bigint): Uint8Array {
    const result = codec.encode(value);
    if (result.length > BIGNUM_MAX_BYTES) {
        throw new Error(`BigNum value exceeds 520 bytes (encoded to ${result.length} bytes)`);
    }
    return result;
}

/**
 * Decode a minimal sign-magnitude little-endian byte string into a bigint.
 * Throws on non-minimal encodings or values longer than 520 bytes.
 */
export function decode(value: Uint8Array): bigint {
    return codec.decode(value);
}
