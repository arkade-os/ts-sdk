/**
 * BigNum — arbitrary-precision sign-magnitude little-endian encoding used by
 * the arkade VM in introspector v0.0.1. Up to 520 bytes (= MaxScriptElementSize).
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

/**
 * Encode `value` to exactly `size` bytes by padding with zero magnitude bytes
 * between the value and the sign bit. Throws if the value doesn't fit.
 *
 * Useful when matching arkade VM outputs that push values as fixed-size byte
 * strings (e.g. some asset opcodes that push 8-byte LE values).
 */
export function encodeFixed(value: bigint, size: number): Uint8Array {
    if (size < 0) throw new Error(`negative fixed size ${size}`);
    if (size === 0) {
        if (value !== 0n) throw new Error(`value ${value} does not fit in 0 bytes`);
        return new Uint8Array(0);
    }
    const minimal = encode(value);
    if (minimal.length === 0) {
        return new Uint8Array(size);
    }
    if (minimal.length > size) {
        throw new Error(`value needs ${minimal.length} bytes, size=${size}`);
    }
    const out = new Uint8Array(size);
    const sign = minimal[minimal.length - 1] & 0x80;
    // Copy magnitude with sign bit stripped from the magnitude's MSB.
    out.set(minimal);
    out[minimal.length - 1] &= 0x7f;
    // Apply sign on the LAST byte of the output buffer.
    out[size - 1] |= sign;
    return out;
}
