/**
 * Arkade Script Encoding and Decoding
 *
 * This module provides script encoding/decoding and ASM conversion helpers
 * that work with both standard Bitcoin opcodes and Arkade extension opcodes.
 *
 * Note: We use our own decoder for scripts because @scure/btc-signer doesn't
 * recognize Arkade opcodes (0xc4-0xf2) and would treat them as data pushes.
 */

import * as P from "micro-packed";
import { Script, ScriptNum, type ScriptType, OP } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { ARKADE_OP } from "./opcodes";

// Re-export Script and ScriptType from @scure
export { Script, type ScriptType };

/**
 * Combined OP map: standard Bitcoin opcodes + Arkade extension opcodes.
 * Keys follow @scure convention (without OP_ prefix for most).
 */
export const ARKADE_OPS = { ...OP, ...ARKADE_OP } as const;

/** Reverse lookup: byte value → opcode name */
const ArkadeOPNames: Record<number, string> = {};
for (const [k, v] of Object.entries(ARKADE_OPS)) {
    if (typeof v === "number") ArkadeOPNames[v] = k;
}

/** A single script operation: opcode string key, raw bytes, or number */
export type ArkadeScriptOP = keyof typeof ARKADE_OPS | Uint8Array | number;

/** Array of script operations — the type that ArkadeScript encodes/decodes */
export type ArkadeScriptType = ArkadeScriptOP[];

/**
 * Script CoderType with Arkade extension opcodes.
 *
 * Same API as `Script` from @scure/btc-signer, but with Arkade extension opcodes.
 *
 * @example
 * ```typescript
 * const script: ArkadeScriptType = ['DUP', 'HASH160', pubkeyHash, 'EQUALVERIFY', 'ADD64'];
 * const bytes = ArkadeScript.encode(script);
 * const decoded = ArkadeScript.decode(bytes);
 * ```
 */
export const ArkadeScript: P.CoderType<ArkadeScriptType> = P.wrap({
    encodeStream: (w: P.Writer, value: ArkadeScriptType) => {
        for (let o of value) {
            if (typeof o === "string") {
                const v = ARKADE_OPS[o as keyof typeof ARKADE_OPS];
                if (v === undefined) throw new Error(`Unknown opcode=${o}`);
                w.byte(v);
                continue;
            } else if (typeof o === "number") {
                if (o === 0x00) {
                    w.byte(0x00);
                    continue;
                } else if (1 <= o && o <= 16) {
                    w.byte(OP.OP_1 - 1 + o);
                    continue;
                }
            }
            // Encode big numbers
            if (typeof o === "number") o = ScriptNum().encode(BigInt(o));
            if (!(o instanceof Uint8Array))
                throw new Error(`Wrong Script OP=${o} (${typeof o})`);
            // Bytes (data push)
            const len = o.length;
            if (len < OP.PUSHDATA1) w.byte(len);
            else if (len <= 0xff) {
                w.byte(OP.PUSHDATA1);
                w.byte(len);
            } else if (len <= 0xffff) {
                w.byte(OP.PUSHDATA2);
                w.bytes(P.U16LE.encode(len));
            } else {
                w.byte(OP.PUSHDATA4);
                w.bytes(P.U32LE.encode(len));
            }
            w.bytes(o);
        }
    },
    decodeStream: (r: P.Reader): ArkadeScriptType => {
        const out: ArkadeScriptType = [];
        while (!r.isEnd()) {
            const cur = r.byte();
            // Data push: 0 < cur <= PUSHDATA4
            if (OP.OP_0 < cur && cur <= OP.PUSHDATA4) {
                let len;
                if (cur < OP.PUSHDATA1) len = cur;
                else if (cur === OP.PUSHDATA1) len = P.U8.decodeStream(r);
                else if (cur === OP.PUSHDATA2) len = P.U16LE.decodeStream(r);
                else if (cur === OP.PUSHDATA4) len = P.U32LE.decodeStream(r);
                else throw new Error("Should be not possible");
                out.push(r.bytes(len));
            } else if (cur === 0x00) {
                out.push(0);
            } else if (OP.OP_1 <= cur && cur <= OP.OP_16) {
                out.push(cur - (OP.OP_1 - 1));
            } else {
                const op = ArkadeOPNames[cur] as keyof typeof ARKADE_OPS;
                if (op === undefined)
                    throw new Error(`Unknown opcode=${cur.toString(16)}`);
                out.push(op);
            }
        }
        return out;
    },
});

// ============================================================================
// ASM Conversion
// ============================================================================

/**
 * Convert script operations to ASM (assembly) format.
 * Supports both Bitcoin and Arkade opcodes.
 *
 * @example
 * ```typescript
 * toASM(['DUP', 'HASH160', 'INSPECTOUTPUTVALUE']) // "OP_DUP OP_HASH160 OP_INSPECTOUTPUTVALUE"
 * toASM(ArkadeScript.decode(bytes))
 * ```
 */
export function toASM(script: ArkadeScriptType): string {
    const parts: string[] = [];

    for (const op of script) {
        if (typeof op === "string") {
            // Opcode name from ArkadeOPNames — add OP_ prefix for ASM format
            const name = op.startsWith("OP_") ? op : `OP_${op}`;
            parts.push(name);
        } else if (typeof op === "number") {
            if (op === 0) {
                parts.push("OP_0");
            } else if (op >= 1 && op <= 16) {
                parts.push(`OP_${op}`);
            } else {
                parts.push(op.toString());
            }
        } else {
            // Uint8Array data
            parts.push(hex.encode(op));
        }
    }

    return parts.join(" ");
}

/**
 * Parse ASM (assembly) format to script operations.
 * Supports both Bitcoin and Arkade opcodes.
 *
 * @example
 * ```typescript
 * fromASM("OP_DUP OP_HASH160 deadbeef OP_ADD64")
 * // => ['DUP', 'HASH160', Uint8Array, 'ADD64']
 * ```
 */
export function fromASM(asm: string): ArkadeScriptType {
    const tokens = asm.trim().split(/\s+/).filter(Boolean);
    const out: ArkadeScriptType = [];

    for (const token of tokens) {
        // OP_0 → number 0
        if (token === "OP_0" || token === "OP_FALSE") {
            out.push(0);
            continue;
        }

        // OP_1 through OP_16 → number
        const numMatch = token.match(/^OP_(\d+)$/);
        if (numMatch) {
            const n = parseInt(numMatch[1], 10);
            if (n >= 1 && n <= 16) {
                out.push(n);
                continue;
            }
        }

        // Try opcode lookup: strip OP_ prefix to get the key in ARKADE_OPS
        let key: string | undefined;
        if (token.startsWith("OP_")) {
            key = token.slice(3);
        } else {
            key = token;
        }

        if (key in ARKADE_OPS) {
            out.push(key as keyof typeof ARKADE_OPS);
            continue;
        }

        // Try to parse as hex data
        if (/^[0-9a-fA-F]+$/.test(token) && token.length % 2 === 0) {
            try {
                out.push(hex.decode(token));
                continue;
            } catch {
                // Not valid hex, fall through
            }
        }

        throw new Error(`Invalid ASM token: ${token}`);
    }

    return out;
}

/**
 * Convert ASM string directly to script bytes
 */
export function asmToBytes(asm: string): Uint8Array {
    return ArkadeScript.encode(fromASM(asm));
}

/**
 * Convert script bytes directly to ASM string
 */
export function bytesToASM(script: Uint8Array): string {
    return toASM(ArkadeScript.decode(script));
}
