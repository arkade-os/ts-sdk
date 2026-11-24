import { hex } from "@scure/base";
import { KIND, plainError, scriptError } from "./errors";
import { checkMinimalDataEncoding, encodeSignMagnitude } from "./scriptnum";

export const maxBigNumLen = 520;

const int64ByteCap = 8;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;
const maxModexpOperandBits = maxBigNumLen * 8;

const fitsInt64 = (v: bigint): boolean => v >= INT64_MIN && v <= INT64_MAX;
const bitLen = (v: bigint): number => (v === 0n ? 0 : (v < 0n ? -v : v).toString(2).length);

/**
 * Go's BigNum tagged union. `useBig` is semantic: CLTV, CSV and curve ids reject a big-path
 * value whatever its magnitude, and a value never leaves the big path once on it.
 */
export class BigNum {
    constructor(
        readonly value: bigint,
        readonly useBig: boolean,
    ) {
        if (!useBig && !fitsInt64(value))
            throw new RangeError(`int64 BigNum out of range: ${value}`);
    }

    static fromInt64(v: number | bigint): BigNum {
        return new BigNum(BigInt(v), false);
    }

    static fromUint64(v: number | bigint): BigNum {
        const b = BigInt(v);
        if (b < 0n || b >> 64n !== 0n) throw new RangeError(`not a uint64: ${b}`);
        return new BigNum(b, b > INT64_MAX);
    }

    static fromBytes(v: Uint8Array): BigNum {
        if (v.length > maxBigNumLen) {
            throw scriptError(
                "ErrNumberTooBig",
                `numeric value encoded as ${hex.encode(v)} is ${v.length} bytes which exceeds the max allowed of ${maxBigNumLen}`,
            );
        }
        checkMinimalDataEncoding(v);
        let magnitude = 0n;
        for (let i = v.length - 1; i >= 0; i--) {
            magnitude = (magnitude << 8n) | BigInt(i === v.length - 1 ? v[i] & 0x7f : v[i]);
        }
        const negative = v.length > 0 && (v[v.length - 1] & 0x80) !== 0;
        return new BigNum(negative ? -magnitude : magnitude, v.length > int64ByteCap);
    }

    // Go returns the int64 path only when both operands are on it and nothing overflowed.
    private static result(v: bigint, big: boolean): BigNum {
        return new BigNum(v, big || !fitsInt64(v));
    }

    bytes(): Uint8Array {
        const out = encodeSignMagnitude(this.value);
        if (out.length > maxBigNumLen) {
            throw scriptError(
                "ErrNumberTooBig",
                `BigNum result encoded as ${out.length} bytes exceeds max allowed of ${maxBigNumLen}`,
            );
        }
        return out;
    }

    /** Not zero-padding of bytes(): the sign bit moves to the last byte of the fixed width. */
    fixedBytes(size: number): Uint8Array {
        if (size < 0) throw plainError(KIND.fixedBytes, `negative fixed size ${size}`);
        const encoded = this.bytes();
        if (encoded.length > size) {
            throw plainError(KIND.fixedBytes, `number needs ${encoded.length} bytes, size=${size}`);
        }
        const out = new Uint8Array(size);
        if (encoded.length === 0) return out;
        const last = encoded.length - 1;
        const sign = encoded[last] & 0x80;
        const magnitude = Uint8Array.from(encoded);
        magnitude[last] &= 0x7f;
        out.set(magnitude[last] === 0 ? magnitude.subarray(0, last) : magnitude);
        out[size - 1] |= sign;
        return out;
    }

    isZero(): boolean {
        return this.value === 0n;
    }

    sign(): number {
        return this.value === 0n ? 0 : this.value < 0n ? -1 : 1;
    }

    cmp(m: BigNum): number {
        return this.value === m.value ? 0 : this.value < m.value ? -1 : 1;
    }

    add(m: BigNum): BigNum {
        return BigNum.result(this.value + m.value, this.useBig || m.useBig);
    }

    sub(m: BigNum): BigNum {
        return BigNum.result(this.value - m.value, this.useBig || m.useBig);
    }

    mul(m: BigNum): BigNum {
        return BigNum.result(this.value * m.value, this.useBig || m.useBig);
    }

    div(m: BigNum): BigNum {
        if (m.isZero()) throw plainError(KIND.divisionByZero, "division by zero");
        return new BigNum(this.value / m.value, this.bigQuotient(m));
    }

    mod(m: BigNum): BigNum {
        if (m.isZero()) throw plainError(KIND.moduloByZero, "modulo by zero");
        return new BigNum(this.value % m.value, this.bigQuotient(m));
    }

    // MinInt64 % -1 is 0 yet lands on the big path, because Go guards the pair, not the result
    private bigQuotient(m: BigNum): boolean {
        return this.useBig || m.useBig || (this.value === INT64_MIN && m.value === -1n);
    }

    modexp(exp: BigNum, modulus: BigNum): BigNum {
        if (modulus.sign() <= 0) {
            throw plainError(KIND.modulusNotPositive, "modulus must be positive");
        }
        if (exp.sign() < 0) throw plainError(KIND.negativeExponent, "negative exponent");
        for (const operand of [this.value, exp.value, modulus.value]) {
            if (bitLen(operand) > maxModexpOperandBits) {
                throw plainError(KIND.modexpOperandTooLarge, "modexp operand too large");
            }
        }
        const m = modulus.value;
        let result = m === 1n ? 0n : 1n;
        let base = ((this.value % m) + m) % m;
        for (let e = exp.value; e > 0n && m !== 1n; e >>= 1n) {
            if (e & 1n) result = (result * base) % m;
            base = (base * base) % m;
        }
        return new BigNum(result, true);
    }

    negate(): BigNum {
        return BigNum.result(-this.value, this.useBig);
    }

    abs(): BigNum {
        return BigNum.result(this.value < 0n ? -this.value : this.value, this.useBig);
    }

    lshift(shift: number): BigNum {
        if (this.isZero()) return this;
        if (shift > maxBigNumLen * 8) {
            throw scriptError(
                "ErrNumberTooBig",
                `LSHIFT result would exceed ${maxBigNumLen} bytes`,
            );
        }
        const out = new BigNum(this.value << BigInt(shift), true);
        out.bytes();
        return out;
    }

    /** Rounds toward negative infinity, unlike div: -7 >> 1 is -4. */
    rshift(shift: number): BigNum {
        if (this.isZero()) return this;
        return new BigNum(this.value >> BigInt(shift), true);
    }
}

/** BIN2NUM's normaliser: strips padding and maps every negative zero to the empty string. */
export function minimallyEncode(v: Uint8Array): Uint8Array {
    if (v.length === 0) return new Uint8Array(0);
    const out = Uint8Array.from(v);
    const sign = out[out.length - 1] & 0x80;
    out[out.length - 1] &= 0x7f;
    let n = out.length;
    while (n > 0 && out[n - 1] === 0) n--;
    if (n === 0) return new Uint8Array(0);
    if (out[n - 1] & 0x80) {
        const extended = new Uint8Array(n + 1);
        extended.set(out.subarray(0, n));
        extended[n] = sign;
        return extended;
    }
    const trimmed = out.slice(0, n);
    trimmed[n - 1] |= sign;
    return trimmed;
}
