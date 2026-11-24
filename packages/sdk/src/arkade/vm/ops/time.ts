import { scriptError } from "../errors";
import type { FamilyHandlers, OpcodeHandler } from "../opcodes";

const LOCKTIME_THRESHOLD = 500_000_000;
const MAX_TX_IN_SEQUENCE = 0xffffffff;
const SEQUENCE_LOCKTIME_DISABLED = 0x80000000;
const SEQUENCE_LOCKTIME_IS_SECONDS = 0x00400000;
const SEQUENCE_LOCKTIME_MASK = 0x0000ffff;

function verifyLockTime(txLockTime: number, threshold: number, lockTime: number): void {
    if (txLockTime < threshold !== lockTime < threshold) {
        throw scriptError(
            "ErrUnsatisfiedLockTime",
            `mismatched locktime types -- tx locktime ${txLockTime}, stack locktime ${lockTime}`,
        );
    }
    if (lockTime > txLockTime) {
        throw scriptError(
            "ErrUnsatisfiedLockTime",
            `locktime requirement not satisfied -- locktime is greater than the transaction locktime: ${lockTime} > ${txLockTime}`,
        );
    }
}

const checkLockTimeVerify: OpcodeHandler = (_op, _data, vm) => {
    const n = vm.dstack.peekBigNum(0);
    if (n.sign() < 0) throw scriptError("ErrNegativeLockTime", `negative lock time: ${n.value}`);
    if (n.useBig || n.value > 0xffffffffn) {
        throw scriptError("ErrUnsatisfiedLockTime", "locktime value exceeds uint32");
    }
    verifyLockTime(vm.tx.locktime, LOCKTIME_THRESHOLD, Number(n.value));
    if (vm.tx.inputs[vm.txIdx].sequence === MAX_TX_IN_SEQUENCE) {
        throw scriptError("ErrUnsatisfiedLockTime", "transaction input is finalized");
    }
};

const checkSequenceVerify: OpcodeHandler = (_op, _data, vm) => {
    const n = vm.dstack.peekBigNum(0);
    if (n.sign() < 0) throw scriptError("ErrNegativeLockTime", `negative sequence: ${n.value}`);
    if (n.useBig || n.value > 0xffffffffn) {
        throw scriptError("ErrUnsatisfiedLockTime", "sequence value exceeds uint32");
    }
    const stackSequence = Number(n.value);
    if ((stackSequence & SEQUENCE_LOCKTIME_DISABLED) !== 0) return;
    if (vm.tx.version < 2) {
        throw scriptError(
            "ErrUnsatisfiedLockTime",
            `invalid transaction version: ${vm.tx.version}`,
        );
    }
    const txSequence = vm.tx.inputs[vm.txIdx].sequence;
    if ((txSequence & SEQUENCE_LOCKTIME_DISABLED) !== 0) {
        throw scriptError(
            "ErrUnsatisfiedLockTime",
            `transaction sequence has sequence locktime disabled bit set: 0x${txSequence.toString(16)}`,
        );
    }
    const mask = SEQUENCE_LOCKTIME_IS_SECONDS | SEQUENCE_LOCKTIME_MASK;
    verifyLockTime(txSequence & mask, SEQUENCE_LOCKTIME_IS_SECONDS, stackSequence & mask);
};

const pushExpiry: OpcodeHandler = (_op, _data, vm) => {
    if (vm.expiry === undefined) {
        throw scriptError("ErrInvalidStackOperation", "OP_PUSHEXPIRY expiry not set");
    }
    vm.dstack.pushInt(vm.expiry);
};

// pushes the comparison instead of failing, unlike CLTV
const checkTime: OpcodeHandler = (_op, _data, vm) => {
    const n = vm.dstack.popBigNum();
    if (n.sign() < 0) throw scriptError("ErrNegativeLockTime", `negative timestamp: ${n.value}`);
    vm.dstack.pushBool(n.cmp(vm.currentTime) <= 0);
};

export const timeHandlers: FamilyHandlers<"time"> = {
    OP_CHECKLOCKTIMEVERIFY: checkLockTimeVerify,
    OP_CHECKSEQUENCEVERIFY: checkSequenceVerify,
    OP_PUSHEXPIRY: pushExpiry,
    OP_CHECKTIME: checkTime,
};
