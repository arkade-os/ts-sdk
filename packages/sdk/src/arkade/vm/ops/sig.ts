import type { Engine, TaprootExecutionCtx } from "../engine";
import { KIND, ScriptError, scriptError } from "../errors";
import type { FamilyHandlers, Opcode, OpcodeHandler } from "../opcodes";
import { computeArkadeSighash, isValidTaprootSigHash } from "../sighash";
import { parseSchemePubKey } from "../sigscheme";

function taprootCtx(op: Opcode, vm: Engine): TaprootExecutionCtx {
    if (!vm.taprootCtx) {
        throw scriptError("ErrReservedOpcode", `attempt to execute invalid opcode ${op.name}`);
    }
    return vm.taprootCtx;
}

function splitTaprootSig(raw: Uint8Array): { sig: Uint8Array; hashType: number } {
    if (raw.length === 64) return { sig: raw, hashType: 0x00 };
    if (raw.length === 65 && raw[64] !== 0) return { sig: raw.subarray(0, 64), hashType: raw[64] };
    throw scriptError("ErrInvalidTaprootSigLen", `invalid sig len: ${raw.length}`);
}

// a bad key or sig length fails the script; a sighash that cannot be built is an invalid sig
function verifyTapscriptSig(pk: Uint8Array, fullSig: Uint8Array, vm: Engine): boolean {
    const verify = parseSchemePubKey(pk);
    const { sig, hashType } = splitTaprootSig(fullSig);
    let sigHash: Uint8Array;
    try {
        sigHash = computeArkadeSighash(vm, hashType);
    } catch (err) {
        if (err instanceof ScriptError && err.kind !== KIND.panic) return false;
        throw err;
    }
    return verify(sigHash, sig);
}

const nullFail = () => scriptError("ErrNullFail", "signature not empty on failed checksig");

const checkSig: OpcodeHandler = (op, _data, vm) => {
    taprootCtx(op, vm);
    const pk = vm.dstack.popByteArray();
    const sig = vm.dstack.popByteArray();
    if (pk.length === 0) throw scriptError("ErrTaprootPubkeyIsEmpty", "");
    // before the key is parsed: an empty sig never fails on the key's scheme
    if (sig.length === 0) return vm.dstack.pushByteArray(new Uint8Array(0));
    if (!verifyTapscriptSig(pk, sig, vm)) throw nullFail();
    vm.dstack.pushBool(true);
};

const checkSigVerify: OpcodeHandler = (op, data, vm) => {
    checkSig(op, data, vm);
    if (!vm.dstack.popBool()) throw scriptError("ErrCheckSigVerify", `${op.name} failed`);
};

const checkSigAdd: OpcodeHandler = (op, _data, vm) => {
    taprootCtx(op, vm);
    const pk = vm.dstack.popByteArray();
    const n = vm.dstack.popInt();
    const sig = vm.dstack.popByteArray();
    if (pk.length === 0) throw scriptError("ErrTaprootPubkeyIsEmpty", "");
    if (sig.length === 0) return vm.dstack.pushInt(n);
    if (!verifyTapscriptSig(pk, sig, vm)) throw nullFail();
    // n + 1 may need five bytes, which a later popInt rejects
    vm.dstack.pushInt(n + 1);
};

// needs no taproot context; the empty-sig return comes before the key is parsed
const checkSigFromStack: OpcodeHandler = (_op, _data, vm) => {
    const pk = vm.dstack.popByteArray();
    const msg = vm.dstack.popByteArray();
    const sig = vm.dstack.popByteArray();
    if (sig.length === 0) return vm.dstack.pushByteArray(new Uint8Array(0));
    if (!parseSchemePubKey(pk)(msg, sig)) {
        throw scriptError("ErrNullFail", "signature verification failed");
    }
    vm.dstack.pushInt(1);
};

// the opcode counter, pushes included, not the byte offset
const codeSeparator: OpcodeHandler = (op, _data, vm) => {
    taprootCtx(op, vm).codeSepPos = vm.tokenizer.opcodePosition() >>> 0;
};

const sigHash: OpcodeHandler = (op, _data, vm) => {
    taprootCtx(op, vm);
    const flag = vm.dstack.popInt();
    if (flag < 0 || flag > 0xff) {
        throw scriptError("ErrNumberTooBig", `sighash flag ${flag} out of range [0,255]`);
    }
    if (!isValidTaprootSigHash(flag)) {
        throw scriptError(
            "ErrInvalidSigHashType",
            `invalid sighash flag 0x${flag.toString(16).padStart(2, "0")}`,
        );
    }
    if ((flag & 0x7f) === 0x03 && vm.txIdx >= vm.tx.outputs.length) {
        throw scriptError(
            "ErrInvalidSigHashType",
            `SIGHASH_SINGLE: no output at input index ${vm.txIdx} (tx has ${vm.tx.outputs.length} outputs)`,
        );
    }
    vm.dstack.pushByteArray(computeArkadeSighash(vm, flag));
};

const checkMultiSig: OpcodeHandler = () => {
    throw scriptError(
        "ErrTapscriptCheckMultisig",
        "OP_CHECKMULTISIG and OP_CHECKMULTISIGVERIFY are disabled during tapscript execution",
    );
};

export const sigHandlers: FamilyHandlers<"sig"> = {
    OP_CODESEPARATOR: codeSeparator,
    OP_CHECKSIG: checkSig,
    OP_CHECKSIGVERIFY: checkSigVerify,
    OP_CHECKMULTISIG: checkMultiSig,
    OP_CHECKMULTISIGVERIFY: checkMultiSig,
    OP_CHECKSIGADD: checkSigAdd,
    OP_CHECKSIGFROMSTACK: checkSigFromStack,
    OP_SIGHASH: sigHash,
};
