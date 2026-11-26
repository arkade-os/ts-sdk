import type { Engine } from "./engine";
import { scriptError } from "./errors";
import { type FamilyName, INVALID, OPCODE_FAMILIES, opcodeNames, RESERVED } from "./opnames";
import { arithHandlers } from "./ops/arith";
import { assetsHandlers } from "./ops/assets";
import { coreHandlers } from "./ops/core";
import { ecopsHandlers } from "./ops/ecops";
import { hashopsHandlers } from "./ops/hashops";
import { introspectHandlers } from "./ops/introspect";
import { packetsHandlers } from "./ops/packets";
import { sigHandlers } from "./ops/sig";
import { timeHandlers } from "./ops/time";

export type OpcodeHandler = (op: Opcode, data: Uint8Array, vm: Engine) => void;

/** `length`: 1 = no data, >1 = total size including the opcode, <0 = negated length-prefix width. */
export interface Opcode {
    readonly value: number;
    readonly name: string;
    readonly length: number;
    readonly handler: OpcodeHandler;
}

export type FamilyHandlers<F extends FamilyName> = {
    readonly [K in keyof (typeof OPCODE_FAMILIES)[F]]: OpcodeHandler;
};

const FAMILY_HANDLERS: { readonly [F in FamilyName]: FamilyHandlers<F> } = {
    core: coreHandlers,
    arith: arithHandlers,
    hashops: hashopsHandlers,
    introspect: introspectHandlers,
    time: timeHandlers,
    sig: sigHandlers,
    ecops: ecopsHandlers,
    assets: assetsHandlers,
    packets: packetsHandlers,
};

const pushData: OpcodeHandler = (_op, data, vm) => vm.dstack.pushByteArray(data);
const pushFalse: OpcodeHandler = (_op, _data, vm) => vm.dstack.pushByteArray(new Uint8Array(0));
const push1Negate: OpcodeHandler = (_op, _data, vm) => vm.dstack.pushInt(-1);
const pushN: OpcodeHandler = (op, _data, vm) => vm.dstack.pushInt(op.value - 0x50);
const reserved: OpcodeHandler = (op) => {
    throw scriptError("ErrReservedOpcode", `attempt to execute reserved opcode ${op.name}`);
};
const invalid: OpcodeHandler = (op) => {
    throw scriptError("ErrReservedOpcode", `attempt to execute invalid opcode ${op.name}`);
};

const lengthOf = (value: number): number => {
    if (value >= 0x01 && value <= 0x4b) return value + 1;
    return { 0x4c: -1, 0x4d: -2, 0x4e: -4 }[value] ?? 1;
};

function buildTable(): Opcode[] {
    const handlers: (OpcodeHandler | undefined)[] = [pushFalse];
    for (let n = 1; n <= 0x4e; n++) handlers[n] = pushData;
    handlers[0x4f] = push1Negate;
    for (let n = 1; n <= 16; n++) handlers[0x50 + n] = pushN;
    for (const value of Object.values(RESERVED)) handlers[value] = reserved;
    for (const value of Object.values(INVALID)) handlers[value] = invalid;
    for (const family of Object.keys(OPCODE_FAMILIES) as FamilyName[]) {
        const fill: Readonly<Record<string, OpcodeHandler>> | undefined = FAMILY_HANDLERS[family];
        for (const [name, value] of Object.entries(OPCODE_FAMILIES[family])) {
            handlers[value] = fill?.[name];
        }
    }
    return opcodeNames.map((name, value) => {
        const handler = handlers[value];
        // a bundler that turns an import cycle back on yields undefined here, not a TDZ error
        if (!handler) throw new Error(`no handler for ${name}`);
        return { value, name, length: lengthOf(value), handler };
    });
}

export const opcodeArray: readonly Opcode[] = buildTable();
