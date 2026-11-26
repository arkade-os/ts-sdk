import { hex } from "@scure/base";
import { KIND, plainError, scriptError } from "./errors";

export const maxScriptNumLen = 4;

const MIN_INT64 = -(1n << 63n);

export function checkMinimalDataEncoding(v: Uint8Array): void {
    const last = v.length - 1;
    // the exception is a sign-extension byte: +-255 encode as ff00 / ff80
    if (last >= 0 && (v[last] & 0x7f) === 0 && (last === 0 || (v[last - 1] & 0x80) === 0)) {
        throw scriptError(
            "ErrMinimalData",
            `numeric value encoded as ${hex.encode(v)} is not minimally encoded`,
        );
    }
}

/** MakeScriptNum with Go's only width, 4 bytes, so the result is always a safe integer. */
export function makeScriptNum(v: Uint8Array, requireMinimal: boolean): number {
    if (v.length > maxScriptNumLen) {
        throw scriptError(
            "ErrNumberTooBig",
            `numeric value encoded as ${hex.encode(v)} is ${v.length} bytes which exceeds the max allowed of ${maxScriptNumLen}`,
        );
    }
    if (requireMinimal) checkMinimalDataEncoding(v);
    if (v.length === 0) return 0;
    let result = 0;
    for (let i = 0; i < v.length; i++) result += v[i] * 2 ** (8 * i);
    const last = v.length - 1;
    if (v[last] & 0x80) return -(result - 0x80 * 2 ** (8 * last));
    return result;
}

/** Minimal sign-magnitude little-endian encoding, shared with BigNum. */
export function encodeSignMagnitude(v: bigint): Uint8Array {
    if (v === 0n) return new Uint8Array(0);
    const negative = v < 0n;
    let magnitude = negative ? -v : v;
    const out: number[] = [];
    while (magnitude > 0n) {
        out.push(Number(magnitude & 0xffn));
        magnitude >>= 8n;
    }
    if (out[out.length - 1] & 0x80) out.push(negative ? 0x80 : 0x00);
    else if (negative) out[out.length - 1] |= 0x80;
    return Uint8Array.from(out);
}

/** scriptNum.Bytes over Go's int64 domain. */
export function scriptNumBytes(n: number | bigint): Uint8Array {
    const v = BigInt(n);
    // Go's `n = -n` leaves MinInt64 negative and then indexes result[-1]: a panic
    if (v === MIN_INT64) throw plainError(KIND.panic, "scriptNum.Bytes of math.MinInt64");
    return encodeSignMagnitude(v);
}
