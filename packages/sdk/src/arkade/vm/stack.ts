import { BigNum } from "./bignum";
import { scriptError } from "./errors";
import { makeScriptNum, scriptNumBytes } from "./scriptnum";

export const OpCondFalse = 0;
export const OpCondTrue = 1;
export const OpCondSkip = 2;

/** 0x80 is false only as the last byte: [0x80, 0x00] is true. */
export function asBool(t: Uint8Array): boolean {
    for (let i = 0; i < t.length; i++) {
        if (t[i] !== 0) return !(i === t.length - 1 && t[i] === 0x80);
    }
    return false;
}

export function fromBool(v: boolean): Uint8Array {
    return v ? Uint8Array.of(1) : new Uint8Array(0);
}

const invalidIndex = (idx: number, size: number) =>
    scriptError("ErrInvalidStackOperation", `index ${idx} is invalid for stack size ${size}`);

/** Elements are shared between slots (dup, pick), so they must never be mutated in place. */
export class Stack {
    stk: Uint8Array[] = [];
    verifyMinimalData = false;

    depth(): number {
        return this.stk.length;
    }

    pushByteArray(so: Uint8Array): void {
        this.stk.push(so);
    }

    pushInt(n: number | bigint): void {
        this.pushByteArray(scriptNumBytes(n));
    }

    pushBool(v: boolean): void {
        this.pushByteArray(fromBool(v));
    }

    pushBigNum(n: BigNum): void {
        this.pushByteArray(n.bytes());
    }

    popByteArray(): Uint8Array {
        return this.nipN(0);
    }

    popInt(): number {
        return makeScriptNum(this.popByteArray(), this.verifyMinimalData);
    }

    popBool(): boolean {
        return asBool(this.popByteArray());
    }

    popBigNum(): BigNum {
        return BigNum.fromBytes(this.popByteArray());
    }

    peekByteArray(idx: number): Uint8Array {
        const sz = this.stk.length;
        if (idx < 0 || idx >= sz) throw invalidIndex(idx, sz);
        return this.stk[sz - idx - 1];
    }

    peekInt(idx: number): number {
        return makeScriptNum(this.peekByteArray(idx), this.verifyMinimalData);
    }

    peekBool(idx: number): boolean {
        return asBool(this.peekByteArray(idx));
    }

    peekBigNum(idx: number): BigNum {
        return BigNum.fromBytes(this.peekByteArray(idx));
    }

    nipN(idx: number): Uint8Array {
        const sz = this.stk.length;
        if (idx < 0 || idx > sz - 1) throw invalidIndex(idx, sz);
        return this.stk.splice(sz - idx - 1, 1)[0];
    }

    tuck(): void {
        const so2 = this.popByteArray();
        const so1 = this.popByteArray();
        this.pushByteArray(so2);
        this.pushByteArray(so1);
        this.pushByteArray(so2);
    }

    dropN(n: number): void {
        if (n < 1) {
            throw scriptError("ErrInvalidStackOperation", `attempt to drop ${n} items from stack`);
        }
        for (; n > 0; n--) this.popByteArray();
    }

    dupN(n: number): void {
        if (n < 1) throw scriptError("ErrInvalidStackOperation", `attempt to dup ${n} stack items`);
        for (let i = n; i > 0; i--) this.pushByteArray(this.peekByteArray(n - 1));
    }

    rotN(n: number): void {
        if (n < 1) {
            throw scriptError("ErrInvalidStackOperation", `attempt to rotate ${n} stack items`);
        }
        for (let i = n; i > 0; i--) this.pushByteArray(this.nipN(3 * n - 1));
    }

    swapN(n: number): void {
        if (n < 1)
            throw scriptError("ErrInvalidStackOperation", `attempt to swap ${n} stack items`);
        for (let i = n; i > 0; i--) this.pushByteArray(this.nipN(2 * n - 1));
    }

    overN(n: number): void {
        if (n < 1) {
            throw scriptError(
                "ErrInvalidStackOperation",
                `attempt to perform over on ${n} stack items`,
            );
        }
        for (let i = n; i > 0; i--) this.pushByteArray(this.peekByteArray(2 * n - 1));
    }

    pickN(n: number): void {
        this.pushByteArray(this.peekByteArray(n));
    }

    /** OP_PUT: overwrites in place, unlike every Bitcoin stack op. */
    putN(n: number, so: Uint8Array): void {
        this.peekByteArray(n);
        this.stk[this.stk.length - n - 1] = so;
    }

    rollN(n: number): void {
        this.pushByteArray(this.nipN(n));
    }
}
