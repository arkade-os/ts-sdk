import { equalBytes } from "@noble/curves/utils.js";
import { concatBytes } from "@noble/hashes/utils.js";
import type { Engine } from "../engine";
import { type ArkadeErrorCode, scriptError } from "../errors";
import { MaxScriptElementSize } from "../limits";
import type { FamilyHandlers, Opcode, OpcodeHandler } from "../opcodes";
import { asBool, OpCondFalse, OpCondSkip, OpCondTrue } from "../stack";

const discouraged: OpcodeHandler = (op) => {
    throw scriptError("ErrDiscourageUpgradableNOPs", `${op.name} reserved for soft-fork upgrades`);
};

// Tapscript minimal-if: anything but [] or [0x01] fails rather than being read as a boolean.
function popIfBool(vm: Engine): boolean {
    const so = vm.dstack.popByteArray();
    if (so.length > 1) {
        throw scriptError(
            "ErrMinimalIf",
            `minimal if is active, top element MUST have a length of at most 1, instead length is ${so.length}`,
        );
    }
    if (so.length === 1 && so[0] !== 0x01) {
        throw scriptError(
            "ErrMinimalIf",
            `minimal if is active, top stack item MUST be an empty byte array or 0x01, is instead: ${so[0]}`,
        );
    }
    return asBool(so);
}

const conditional =
    (executeOn: boolean): OpcodeHandler =>
    (_op, _data, vm) => {
        let cond = OpCondSkip;
        if (vm.isBranchExecuting()) cond = popIfBool(vm) === executeOn ? OpCondTrue : OpCondFalse;
        vm.condStack.push(cond);
    };

const unmatched = (op: Opcode) =>
    scriptError(
        "ErrUnbalancedConditional",
        `encountered opcode ${op.name} with no matching opcode to begin conditional execution`,
    );

function verify(op: Opcode, vm: Engine, code: ArkadeErrorCode): void {
    if (!vm.dstack.popBool()) throw scriptError(code, `${op.name} failed`);
}

function popEqual(vm: Engine): boolean {
    const a = vm.dstack.popByteArray();
    return equalBytes(a, vm.dstack.popByteArray());
}

const bitwise =
    (name: string, f: (a: number, b: number) => number): OpcodeHandler =>
    (_op, _data, vm) => {
        const x2 = vm.dstack.popByteArray();
        const x1 = vm.dstack.popByteArray();
        if (x1.length !== x2.length) {
            throw scriptError("ErrInvalidStackOperation", `mismatched operand sizes for ${name}`);
        }
        vm.dstack.pushByteArray(x1.map((b, i) => f(b, x2[i])));
    };

// Splice results are copies, never subarray views: elements are shared between stack slots.
function popSlice(vm: Engine, what: string, range: (n: number, len: number) => [number, number]) {
    const n = vm.dstack.popInt();
    const x = vm.dstack.popByteArray();
    if (n < 0 || n > x.length) throw scriptError("ErrInvalidIndex", `invalid ${what} index`);
    vm.dstack.pushByteArray(x.slice(...range(n, x.length)));
}

export const coreHandlers: FamilyHandlers<"core"> = {
    OP_NOP: () => {},
    OP_NOP1: discouraged,
    OP_NOP5: discouraged,
    OP_NOP6: discouraged,
    OP_NOP7: discouraged,
    OP_NOP8: discouraged,
    OP_NOP9: discouraged,
    OP_NOP10: discouraged,
    OP_IF: conditional(true),
    OP_NOTIF: conditional(false),
    OP_ELSE: (op, _data, vm) => {
        const top = vm.condStack.length - 1;
        if (top < 0) throw unmatched(op);
        if (vm.condStack[top] === OpCondTrue) vm.condStack[top] = OpCondFalse;
        else if (vm.condStack[top] === OpCondFalse) vm.condStack[top] = OpCondTrue;
    },
    OP_ENDIF: (op, _data, vm) => {
        if (vm.condStack.length === 0) throw unmatched(op);
        vm.condStack.pop();
    },
    OP_VERIFY: (op, _data, vm) => verify(op, vm, "ErrVerify"),
    OP_RETURN: () => {
        throw scriptError("ErrEarlyReturn", "script returned early");
    },
    OP_TOALTSTACK: (_op, _data, vm) => vm.astack.pushByteArray(vm.dstack.popByteArray()),
    OP_FROMALTSTACK: (_op, _data, vm) => vm.dstack.pushByteArray(vm.astack.popByteArray()),
    OP_2DROP: (_op, _data, vm) => vm.dstack.dropN(2),
    OP_2DUP: (_op, _data, vm) => vm.dstack.dupN(2),
    OP_3DUP: (_op, _data, vm) => vm.dstack.dupN(3),
    OP_2OVER: (_op, _data, vm) => vm.dstack.overN(2),
    OP_2ROT: (_op, _data, vm) => vm.dstack.rotN(2),
    OP_2SWAP: (_op, _data, vm) => vm.dstack.swapN(2),
    OP_IFDUP: (_op, _data, vm) => {
        const so = vm.dstack.peekByteArray(0);
        if (asBool(so)) vm.dstack.pushByteArray(so);
    },
    OP_DEPTH: (_op, _data, vm) => vm.dstack.pushInt(vm.dstack.depth()),
    OP_DROP: (_op, _data, vm) => vm.dstack.dropN(1),
    OP_DUP: (_op, _data, vm) => vm.dstack.dupN(1),
    OP_NIP: (_op, _data, vm) => {
        vm.dstack.nipN(1);
    },
    OP_OVER: (_op, _data, vm) => vm.dstack.overN(1),
    OP_PICK: (_op, _data, vm) => vm.dstack.pickN(vm.dstack.popInt()),
    OP_ROLL: (_op, _data, vm) => vm.dstack.rollN(vm.dstack.popInt()),
    OP_PUT: (_op, _data, vm) => {
        const n = vm.dstack.popInt();
        vm.dstack.putN(n, vm.dstack.popByteArray());
    },
    OP_ROT: (_op, _data, vm) => vm.dstack.rotN(1),
    OP_SWAP: (_op, _data, vm) => vm.dstack.swapN(1),
    OP_TUCK: (_op, _data, vm) => vm.dstack.tuck(),
    OP_CAT: (_op, _data, vm) => {
        const x2 = vm.dstack.popByteArray();
        const x1 = vm.dstack.popByteArray();
        const size = x1.length + x2.length;
        if (size > MaxScriptElementSize) {
            throw scriptError(
                "ErrElementTooBig",
                `concatenated size ${size} exceeds max allowed size ${MaxScriptElementSize}`,
            );
        }
        vm.dstack.pushByteArray(concatBytes(x1, x2));
    },
    OP_SUBSTR: (_op, _data, vm) => {
        const size = vm.dstack.popInt();
        const begin = vm.dstack.popInt();
        const x = vm.dstack.popByteArray();
        if (begin < 0 || size < 0 || begin + size > x.length) {
            throw scriptError("ErrInvalidIndex", "invalid substring parameters");
        }
        vm.dstack.pushByteArray(x.slice(begin, begin + size));
    },
    OP_LEFT: (_op, _data, vm) => popSlice(vm, "left", (n) => [0, n]),
    // not slice(-n): for n = 0 that is the whole element
    OP_RIGHT: (_op, _data, vm) => popSlice(vm, "right", (n, len) => [len - n, len]),
    OP_SIZE: (_op, _data, vm) => vm.dstack.pushInt(vm.dstack.peekByteArray(0).length),
    OP_INVERT: (_op, _data, vm) =>
        vm.dstack.pushByteArray(vm.dstack.popByteArray().map((b) => b ^ 0xff)),
    OP_AND: bitwise("AND", (a, b) => a & b),
    OP_OR: bitwise("OR", (a, b) => a | b),
    OP_XOR: bitwise("XOR", (a, b) => a ^ b),
    OP_EQUAL: (_op, _data, vm) => vm.dstack.pushBool(popEqual(vm)),
    OP_EQUALVERIFY: (op, _data, vm) => {
        if (!popEqual(vm)) throw scriptError("ErrEqualVerify", `${op.name} failed`);
    },
};
