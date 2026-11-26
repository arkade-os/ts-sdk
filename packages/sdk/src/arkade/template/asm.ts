import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { concatBytes, equalBytes } from "@scure/btc-signer/utils.js";

import {
    BigNum,
    DefaultComputeLimits,
    MaxScriptElementSize,
    MaxScriptSize,
    type Opcode,
    OpcodeByName,
    ScriptTokenizer,
} from "../vm";
import { Failure } from "./errors";

export const MAX_SCRIPT_NUM = 2 ** 53 - 1;
export const SCALAR_TYPES: readonly string[] = [
    "pubkey",
    "signature",
    "bytes",
    "bytes20",
    "bytes32",
    "asset",
    "int",
    "bool",
];
export const DECIMAL_TOKEN = /^(0|-?[1-9][0-9]*)$/;
export const HEX_TOKEN = /^0x([0-9a-f]{2})+$/;
export const SPLICE = /^<!([^<>!]+)>$/;
export const PLACEHOLDER = /^<([^<>]+)>$/;

const KEY_ALIASES: Readonly<Record<string, string>> = {
    SERVER_KEY: "OPERATOR_KEY",
    COSIGNER_KEY: "BATCH_COSIGNER_KEY",
    ENCRYPTION_KEY: "SEALING_KEY",
};

/**
 * The service key a placeholder name stands for, so that documents written with a former name of a
 * key keep their id and their scripts. Any other name is returned as is.
 */
export const serviceKey = (name: string): string =>
    Object.hasOwn(KEY_ALIASES, name) ? KEY_ALIASES[name] : name;

export interface Value {
    type: string;
    raw: Uint8Array;
}

export type Lookup = (name: string) => Value;

// asm.ErrBadExpression and asm.ErrBadValue are outside the code walk, so a bare one codes
// "internal"; every Go caller adds its own kind with %v.
export class AsmError extends Failure {
    constructor(
        message: string,
        readonly sentinel?: "bad_expression" | "bad_value",
        cause?: Failure,
    ) {
        super(cause?.kinds ?? [], message, cause?.path);
    }
}

const FORBIDDEN_PREFIXES = [
    "OP_INSPECTOUTPUT",
    "OP_INSPECTOUTASSET",
    "OP_INSPECTASSETGROUP",
    "OP_INSPECTINPUTARKADE",
    "OP_INSPECTINASSET",
];
const FORBIDDEN_OPS = [
    "OP_INSPECTNUMOUTPUTS",
    "OP_TUNNEL",
    "OP_INSPECTPACKET",
    "OP_INSPECTNUMASSETGROUPS",
    "OP_FINDASSETGROUPBYASSETID",
    "OP_INSPECTINTENTMESSAGE",
    "OP_TXID",
    "OP_TXWEIGHT",
    "OP_SIGHASH",
    "OP_CHECKSIG",
    "OP_CHECKSIGVERIFY",
    "OP_CHECKSIGADD",
];
const CONTEXT_OPS = [
    "OP_PUSHCURRENTINPUTINDEX",
    "OP_PUSHEXPIRY",
    "OP_CHECKTIME",
    "OP_INSPECTVERSION",
    "OP_INSPECTLOCKTIME",
    "OP_INSPECTNUMINPUTS",
    "OP_CHECKLOCKTIMEVERIFY",
    "OP_NOP2",
    "OP_CHECKSEQUENCEVERIFY",
    "OP_NOP3",
];

const OP_NAMES = new Map<number, string[]>();
for (const [name, op] of OpcodeByName) OP_NAMES.set(op, [...(OP_NAMES.get(op) ?? []), name]);

const MAX = BigInt(MAX_SCRIPT_NUM);
const quote = (s: string) => JSON.stringify(s);
const badExpression = (message: string) =>
    new AsmError(`bad expression: ${message}`, "bad_expression");

export function assemble(tokens: readonly string[], lookup?: Lookup): Uint8Array {
    const parts = tokens.map((tok) => token(tok, lookup));
    const size = parts.reduce((n, p) => n + p.length, 0);
    // btcd's ScriptBuilder stops at MaxScriptSize but reports it from Script(), after every token
    if (size > MaxScriptSize) {
        throw new AsmError(`script of ${size} bytes exceeds ${MaxScriptSize}`);
    }
    const script = new Uint8Array(size);
    let offset = 0;
    for (const p of parts) {
        script.set(p, offset);
        offset += p.length;
    }
    return script;
}

export function opcode(tok: string): number {
    const op = OpcodeByName.get(tok);
    if (op === undefined) throw new AsmError(`unknown opcode ${quote(tok)}`);
    // a push opcode would run the next token's data as code
    if (op >= 0x01 && op <= 0x4e) throw new AsmError(`push opcode ${quote(tok)}`);
    return op;
}

// strconv.ParseInt's grammar: BigInt alone would also take "", " 5" and "0x10".
export function parseDecimal(tok: string): number {
    const n = /^[+-]?[0-9]+$/.test(tok) ? BigInt(tok) : undefined;
    if (n === undefined || n > MAX || n < -MAX) {
        throw new AsmError(`number ${quote(tok)} out of range`);
    }
    return Number(n);
}

export function isContextFree(tokens: readonly string[]): boolean {
    return !tokens.some(
        (tok) => forbidden(tok) || tok.startsWith("OP_INSPECTINPUT") || CONTEXT_OPS.includes(tok),
    );
}

export function checkExpression(tokens: readonly string[]): void {
    const bad = tokens.find(forbidden);
    if (bad !== undefined) throw badExpression(`forbidden opcode ${bad}`);
    const count = counter();
    for (const tok of tokens) {
        if ([DECIMAL_TOKEN, HEX_TOKEN, PLACEHOLDER, SPLICE].some((re) => re.test(tok))) continue;
        let op: number;
        try {
            op = opcode(tok);
        } catch (e) {
            throw badExpression((e as Error).message);
        }
        count(op, tok);
    }
}

// Minimal as `assemble` pushes, not the VM's checkMinimalDataPush: 01 00 passes, 521 bytes do not.
export function checkProgram(raw: Uint8Array): void {
    const t = new ScriptTokenizer(raw);
    for (let start = 0; t.next(); start = t.byteIndex()) {
        const op = (t.op as Opcode).value;
        if (op === 0x00 || op > 0x4e) continue;
        const pushed = raw.subarray(start, t.byteIndex());
        if (t.data.length > MaxScriptElementSize || !equalBytes(pushed, push(t.data))) {
            throw badExpression("non-minimal push");
        }
    }
    if (t.err) throw badExpression(t.err.message);
}

export function checkScript(script: Uint8Array, contextFree: boolean): void {
    checkProgram(script);
    const count = counter();
    const t = new ScriptTokenizer(script);
    while (t.next()) {
        const op = (t.op as Opcode).value;
        if (op <= 0x4e) continue;
        const names = OP_NAMES.get(op) ?? [];
        if (names.length === 0) throw badExpression(`unknown opcode 0x${op.toString(16)}`);
        if (names.some(forbidden)) throw badExpression(`forbidden opcode ${names[0]}`);
        if (contextFree && !isContextFree(names)) {
            throw badExpression(`${names[0]} is not context-free`);
        }
        count(op, names[0]);
    }
}

// Messages carry lengths, never bytes: the value may be a sealed plaintext.
export function canonicalBytes(type: string, raw: Uint8Array): void {
    const problem = valueProblem(type, raw);
    if (problem !== undefined) throw new AsmError(`bad value: ${problem}`, "bad_value");
}

export const scriptNum = (n: number): Uint8Array => BigNum.fromInt64(n).bytes();

// Up to 8 bytes, where the VM's makeScriptNum reads 4.
export function parseScriptNum(b: Uint8Array): number {
    let n: bigint | undefined;
    try {
        if (b.length <= 8) n = BigNum.fromBytes(b).value;
    } catch {
        // the VM's message holds the bytes
    }
    if (n === undefined || n > MAX || n < -MAX) {
        throw new AsmError(`bad value: bad number of ${b.length} bytes`, "bad_value");
    }
    return Number(n);
}

function token(tok: string, lookup: Lookup | undefined): Uint8Array {
    if (tok.startsWith("OP_")) return Uint8Array.of(opcode(tok));
    if (DECIMAL_TOKEN.test(tok)) return push(scriptNum(parseDecimal(tok)));
    if (HEX_TOKEN.test(tok)) return data(tok, hex.decode(tok.slice(2)));
    const splice = SPLICE.test(tok);
    if (!splice && !PLACEHOLDER.test(tok)) throw new AsmError(`unsupported token ${quote(tok)}`);
    if (lookup === undefined) throw new AsmError(`${tok}: no lookup`);
    let v: Value;
    try {
        v = lookup(tok.slice(splice ? 2 : 1, -1));
    } catch (e) {
        throw wrapped(tok, e);
    }
    if (splice) return v.raw;
    if (v.type !== "int") return data(tok, v.raw);
    try {
        return push(scriptNum(parseScriptNum(v.raw)));
    } catch (e) {
        throw wrapped(tok, e);
    }
}

// Go's "%s: %w": the cause's sentinel and kinds stay reachable.
function wrapped(tok: string, e: unknown): AsmError {
    const message = `${tok}: ${e instanceof Error ? e.message : String(e)}`;
    const sentinel = e instanceof AsmError ? e.sentinel : undefined;
    return new AsmError(message, sentinel, e instanceof Failure ? e : undefined);
}

function data(tok: string, raw: Uint8Array): Uint8Array {
    if (raw.length > MaxScriptElementSize) {
        throw new AsmError(`${tok}: push of ${raw.length} bytes exceeds ${MaxScriptElementSize}`);
    }
    return push(raw);
}

// btcd's ScriptBuilder.AddData for at most 520 bytes, except that a lone zero byte is
// OP_DATA_1 0x00 where AddData would emit OP_0.
function push(data: Uint8Array): Uint8Array {
    const n = data.length;
    if (n === 1 && data[0] === 0x00) return Uint8Array.of(0x01, 0x00);
    if (n === 0) return Uint8Array.of(0x00);
    if (n === 1 && data[0] <= 16) return Uint8Array.of(0x50 + data[0]);
    if (n === 1 && data[0] === 0x81) return Uint8Array.of(0x4f);
    const prefix = n < 0x4c ? [n] : n <= 0xff ? [0x4c, n] : [0x4d, n & 0xff, n >> 8];
    return concatBytes(Uint8Array.from(prefix), data);
}

function forbidden(tok: string): boolean {
    return FORBIDDEN_OPS.includes(tok) || FORBIDDEN_PREFIXES.some((p) => tok.startsWith(p));
}

// A script has no loops, so counting every occurrence bounds its execution.
function counter(): (op: number, name: string) => void {
    const limits = DefaultComputeLimits();
    const counts = new Map<number, number>();
    return (op, name) => {
        const n = (counts.get(op) ?? 0) + 1;
        counts.set(op, n);
        const limit = limits.get(op);
        if (limit !== undefined && n > limit) {
            throw badExpression(`${name} exceeds its limit of ${limit}`);
        }
    };
}

function valueProblem(type: string, raw: Uint8Array): string | undefined {
    const size = (n: number) => (raw.length === n ? undefined : `${type} must be ${n} bytes`);
    switch (type) {
        case "pubkey":
            return raw.length === 33 && isPoint(raw)
                ? undefined
                : "pubkey must be a valid 33-byte key";
        case "signature":
            return raw.length === 0 || raw.length === 64
                ? undefined
                : "signature must be 64 bytes or empty";
        case "bytes":
            return undefined;
        case "bytes20":
            return size(20);
        case "bytes32":
            return size(32);
        case "asset":
            return size(34);
        case "int":
            try {
                parseScriptNum(raw);
                return undefined;
            } catch (e) {
                return (e as Error).message;
            }
        case "bool":
            return raw.length > 1 || (raw.length === 1 && raw[0] !== 1)
                ? "bool must be empty or 01"
                : undefined;
        default:
            return `unknown type ${quote(type)}`;
    }
}

function isPoint(raw: Uint8Array): boolean {
    try {
        secp256k1.Point.fromBytes(raw);
        return true;
    } catch {
        return false;
    }
}
