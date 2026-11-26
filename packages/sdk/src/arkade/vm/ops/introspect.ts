import { sha256 } from "@noble/hashes/sha2.js";
import { BigNum } from "../bignum";
import type { Engine } from "../engine";
import { scriptError } from "../errors";
import type { FamilyHandlers } from "../opcodes";
import { serializeWitness, taggedHash } from "../tx";
import type { EmulatorEntryLike } from "../types";

const MAX_SATOSHI = 2_100_000_000_000_000n;

function popIndex(vm: Engine, side: "input" | "output"): number {
    const index = vm.dstack.popInt();
    if (index < 0) throw scriptError("ErrInvalidIndex", `${side} index cannot be negative`);
    const count = side === "input" ? vm.tx.inputs.length : vm.tx.outputs.length;
    if (index >= count) throw scriptError("ErrInvalidIndex", `${side} index out of range`);
    return index;
}

function pushSatoshiValue(vm: Engine, value: bigint): void {
    if (value < 0n || value > MAX_SATOSHI) {
        throw scriptError("ErrInvalidStackOperation", "value out of range");
    }
    vm.dstack.pushBigNum(BigNum.fromUint64(value));
}

// txscript.IsWitnessProgram: a small-int version, then one canonical push that ends the script
const isWitnessProgram = (s: Uint8Array): boolean =>
    s.length >= 4 &&
    s.length <= 42 &&
    (s[0] === 0x00 || (s[0] >= 0x51 && s[0] <= 0x60)) &&
    s[1] === s.length - 2;

// two pushes: the program and its version, or sha256(script) and the -1 sentinel
function pushScriptPubKey(vm: Engine, script: Uint8Array): void {
    if (isWitnessProgram(script)) {
        vm.dstack.pushByteArray(script.slice(2));
        vm.dstack.pushInt(script[0] === 0x00 ? 0 : script[0] - 0x50);
        return;
    }
    vm.dstack.pushByteArray(sha256(script));
    vm.dstack.pushInt(-1);
}

// looked up by vin, not by position in the packet
function popEmulatorEntry(vm: Engine): EmulatorEntryLike {
    const index = popIndex(vm, "input");
    if (!vm.emulatorPacket) throw scriptError("ErrInvalidStackOperation", "no emulator packet");
    const entry = vm.emulatorPacket.find((e) => e.vin === index);
    if (!entry) {
        throw scriptError("ErrInvalidStackOperation", `no emulator entry for vin ${index}`);
    }
    return entry;
}

export const introspectHandlers: FamilyHandlers<"introspect"> = {
    OP_INSPECTINPUTOUTPOINT: (_op, _data, vm) => {
        const input = vm.tx.inputs[popIndex(vm, "input")];
        vm.dstack.pushByteArray(input.txid.slice());
        vm.dstack.pushInt(input.index);
    },
    OP_INSPECTINPUTARKADESCRIPTHASH: (_op, _data, vm) => {
        vm.dstack.pushByteArray(taggedHash("ArkScriptHash", popEmulatorEntry(vm).script));
    },
    OP_INSPECTINPUTVALUE: (_op, _data, vm) => {
        const prevOut = vm.prevOutFetcher.fetchPrevOutput(vm.tx.inputs[popIndex(vm, "input")]);
        if (!prevOut) throw scriptError("ErrInvalidIndex", "previous output not found");
        pushSatoshiValue(vm, prevOut.value);
    },
    // the vtxo script even behind a checkpoint, and a miss is a hard failure here
    OP_INSPECTINPUTSCRIPTPUBKEY: (_op, _data, vm) => {
        const input = vm.tx.inputs[popIndex(vm, "input")];
        const script = vm.prevOutFetcher.fetchVtxoPrevOutPkScript(input);
        if (script === undefined) throw scriptError("ErrInvalidIndex", "previous output not found");
        pushScriptPubKey(vm, script);
    },
    OP_INSPECTINPUTSEQUENCE: (_op, _data, vm) => {
        const input = vm.tx.inputs[popIndex(vm, "input")];
        vm.dstack.pushBigNum(BigNum.fromUint64(input.sequence));
    },
    OP_PUSHCURRENTINPUTINDEX: (_op, _data, vm) => vm.dstack.pushInt(vm.txIdx),
    OP_INSPECTINPUTARKADEWITNESSHASH: (_op, _data, vm) => {
        const { witness } = popEmulatorEntry(vm);
        vm.dstack.pushByteArray(
            witness.length === 0
                ? new Uint8Array(32)
                : taggedHash("ArkWitnessHash", serializeWitness(witness)),
        );
    },
    OP_INSPECTOUTPUTVALUE: (_op, _data, vm) => {
        pushSatoshiValue(vm, vm.tx.outputs[popIndex(vm, "output")].value);
    },
    OP_INSPECTOUTPUTSCRIPTPUBKEY: (_op, _data, vm) => {
        pushScriptPubKey(vm, vm.tx.outputs[popIndex(vm, "output")].script);
    },
    OP_INSPECTVERSION: (_op, _data, vm) => {
        vm.dstack.pushBigNum(BigNum.fromUint64(vm.tx.version >>> 0));
    },
    OP_INSPECTLOCKTIME: (_op, _data, vm) => vm.dstack.pushBigNum(BigNum.fromUint64(vm.tx.locktime)),
    OP_INSPECTNUMINPUTS: (_op, _data, vm) => vm.dstack.pushInt(vm.tx.inputs.length),
    OP_INSPECTNUMOUTPUTS: (_op, _data, vm) => vm.dstack.pushInt(vm.tx.outputs.length),
    // the stripped size: witness bytes are never counted, so this is not BIP-141 weight
    OP_TXWEIGHT: (_op, _data, vm) => {
        vm.dstack.pushBigNum(BigNum.fromUint64(vm.strippedSize() * 4));
    },
    OP_TXID: (_op, _data, vm) => vm.dstack.pushByteArray(vm.txID()),
};
