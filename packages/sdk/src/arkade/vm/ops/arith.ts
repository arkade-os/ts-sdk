import { BigNum, maxBigNumLen, minimallyEncode } from "../bignum";
import type { Engine } from "../engine";
import { ScriptError, scriptError } from "../errors";
import type { FamilyHandlers, OpcodeHandler } from "../opcodes";

const maxModexpOperandLen = 64;

const unary =
    (f: (n: BigNum) => BigNum): OpcodeHandler =>
    (_op, _data, vm) =>
        vm.dstack.pushBigNum(f(vm.dstack.popBigNum()));

const unaryBool =
    (f: (n: BigNum) => boolean): OpcodeHandler =>
    (_op, _data, vm) =>
        vm.dstack.pushBool(f(vm.dstack.popBigNum()));

function popPair(vm: Engine): [BigNum, BigNum] {
    const b = vm.dstack.popBigNum();
    return [vm.dstack.popBigNum(), b];
}

const binary =
    (f: (a: BigNum, b: BigNum) => BigNum): OpcodeHandler =>
    (_op, _data, vm) =>
        vm.dstack.pushBigNum(f(...popPair(vm)));

const binaryBool =
    (f: (a: BigNum, b: BigNum) => boolean): OpcodeHandler =>
    (_op, _data, vm) =>
        vm.dstack.pushBool(f(...popPair(vm)));

// The count is popped and sign-checked before the value is decoded.
const shift =
    (f: (n: BigNum, count: number) => BigNum): OpcodeHandler =>
    (_op, _data, vm) => {
        const count = vm.dstack.popInt();
        if (count < 0) throw scriptError("ErrInvalidIndex", "negative shift count");
        vm.dstack.pushBigNum(f(vm.dstack.popBigNum(), count));
    };

export const arithHandlers: FamilyHandlers<"arith"> = {
    OP_1ADD: unary((n) => n.add(BigNum.fromInt64(1))),
    OP_1SUB: unary((n) => n.sub(BigNum.fromInt64(1))),
    OP_2MUL: unary((n) => n.add(n)),
    OP_2DIV: unary((n) => n.div(BigNum.fromInt64(2))),
    OP_NEGATE: unary((n) => n.negate()),
    OP_ABS: unary((n) => n.abs()),
    OP_NOT: unaryBool((n) => n.isZero()),
    OP_0NOTEQUAL: unaryBool((n) => !n.isZero()),
    OP_ADD: binary((a, b) => a.add(b)),
    OP_SUB: binary((a, b) => a.sub(b)),
    OP_MUL: binary((a, b) => a.mul(b)),
    OP_DIV: binary((a, b) => a.div(b)),
    OP_MOD: binary((a, b) => a.mod(b)),
    OP_LSHIFT: shift((n, count) => n.lshift(count)),
    OP_RSHIFT: shift((n, count) => n.rshift(count)),
    OP_BOOLAND: binaryBool((a, b) => !a.isZero() && !b.isZero()),
    OP_BOOLOR: binaryBool((a, b) => !a.isZero() || !b.isZero()),
    OP_NUMEQUAL: binaryBool((a, b) => a.cmp(b) === 0),
    OP_NUMEQUALVERIFY: (op, _data, vm) => {
        const [a, b] = popPair(vm);
        if (a.cmp(b) !== 0) throw scriptError("ErrNumEqualVerify", `${op.name} failed`);
    },
    OP_NUMNOTEQUAL: binaryBool((a, b) => a.cmp(b) !== 0),
    OP_LESSTHAN: binaryBool((a, b) => a.cmp(b) < 0),
    OP_GREATERTHAN: binaryBool((a, b) => a.cmp(b) > 0),
    OP_LESSTHANOREQUAL: binaryBool((a, b) => a.cmp(b) <= 0),
    OP_GREATERTHANOREQUAL: binaryBool((a, b) => a.cmp(b) >= 0),
    OP_MIN: binary((a, b) => (a.cmp(b) < 0 ? a : b)),
    OP_MAX: binary((a, b) => (a.cmp(b) > 0 ? a : b)),
    OP_WITHIN: (_op, _data, vm) => {
        const max = vm.dstack.popBigNum();
        const min = vm.dstack.popBigNum();
        const x = vm.dstack.popBigNum();
        vm.dstack.pushBool(x.cmp(min) >= 0 && x.cmp(max) < 0);
    },
    OP_NUM2BIN: (_op, _data, vm) => {
        const size = vm.dstack.popInt();
        if (size < 0 || size > maxBigNumLen) {
            throw scriptError("ErrNumberTooBig", `invalid OP_NUM2BIN size ${size}`);
        }
        const num = vm.dstack.popBigNum();
        try {
            vm.dstack.pushByteArray(num.fixedBytes(size));
        } catch (err) {
            // Go re-codes every FixedBytes failure, so the ErrFixedBytes kind never escapes
            if (!(err instanceof ScriptError)) throw err;
            throw scriptError("ErrNumberTooBig", `OP_NUM2BIN: ${err.message}`);
        }
    },
    // normalises the raw bytes rather than decoding them, so it accepts what popBigNum rejects
    OP_BIN2NUM: (_op, _data, vm) => {
        const b = vm.dstack.popByteArray();
        if (b.length > maxBigNumLen) {
            throw scriptError("ErrNumberTooBig", `OP_BIN2NUM input exceeds ${maxBigNumLen} bytes`);
        }
        vm.dstack.pushByteArray(minimallyEncode(b));
    },
    OP_REVERSEBYTES: (_op, _data, vm) =>
        vm.dstack.pushByteArray(Uint8Array.from(vm.dstack.popByteArray()).reverse()),
    // the byte cap is checked before BigNum.modexp's sign checks, so it wins over them
    OP_MODEXP: (_op, _data, vm) => {
        const modulus = vm.dstack.popBigNum();
        const exp = vm.dstack.popBigNum();
        const base = vm.dstack.popBigNum();
        const operands: [string, BigNum][] = [
            ["base", base],
            ["exp", exp],
            ["modulus", modulus],
        ];
        for (const [name, n] of operands) {
            const len = n.bytes().length;
            if (len > maxModexpOperandLen) {
                throw scriptError(
                    "ErrNumberTooBig",
                    `OP_MODEXP ${name} is ${len} bytes, exceeds limit of ${maxModexpOperandLen}`,
                );
            }
        }
        vm.dstack.pushBigNum(base.modexp(exp, modulus));
    },
};
