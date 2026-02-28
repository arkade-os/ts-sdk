/**
 * Arkade Script Opcodes
 *
 * This module defines ONLY Arkade-specific opcodes (0xc4-0xf2).
 * Standard Bitcoin opcodes are imported from @scure/btc-signer.
 *
 * Reference: arkade-os/introspector pkg/arkade/opcode.go
 */

import { OP } from "@scure/btc-signer";
export { OP };

export const ARKADE_OP = {
    // SHA256 Streaming (0xc4-0xc6)
    SHA256INITIALIZE: 0xc4,
    SHA256UPDATE: 0xc5,
    SHA256FINALIZE: 0xc6,

    // Input Introspection (0xc7-0xcb)
    INSPECTINPUTOUTPOINT: 0xc7,
    INSPECTINPUTVALUE: 0xc9,
    INSPECTINPUTSCRIPTPUBKEY: 0xca,
    INSPECTINPUTSEQUENCE: 0xcb,

    // Signatures (0xcc-0xcd)
    CHECKSIGFROMSTACK: 0xcc,
    PUSHCURRENTINPUTINDEX: 0xcd,

    // Output Introspection (0xcf, 0xd1)
    INSPECTOUTPUTVALUE: 0xcf,
    INSPECTOUTPUTSCRIPTPUBKEY: 0xd1,

    // Transaction Introspection (0xd2-0xd6)
    INSPECTVERSION: 0xd2,
    INSPECTLOCKTIME: 0xd3,
    INSPECTNUMINPUTS: 0xd4,
    INSPECTNUMOUTPUTS: 0xd5,
    TXWEIGHT: 0xd6,

    // 64-bit Arithmetic (0xd7-0xdf)
    ADD64: 0xd7,
    SUB64: 0xd8,
    MUL64: 0xd9,
    DIV64: 0xda,
    NEG64: 0xdb,
    LESSTHAN64: 0xdc,
    LESSTHANOREQUAL64: 0xdd,
    GREATERTHAN64: 0xde,
    GREATERTHANOREQUAL64: 0xdf,

    // Conversion (0xe0-0xe2)
    SCRIPTNUMTOLE64: 0xe0,
    LE64TOSCRIPTNUM: 0xe1,
    LE32TOLE64: 0xe2,

    // EC Operations (0xe3-0xe4)
    ECMULSCALARVERIFY: 0xe3,
    TWEAKVERIFY: 0xe4,

    // Asset Groups (0xe5-0xf2)
    INSPECTNUMASSETGROUPS: 0xe5,
    INSPECTASSETGROUPASSETID: 0xe6,
    INSPECTASSETGROUPCTRL: 0xe7,
    FINDASSETGROUPBYASSETID: 0xe8,
    INSPECTASSETGROUPMETADATAHASH: 0xe9,
    INSPECTASSETGROUPNUM: 0xea,
    INSPECTASSETGROUP: 0xeb,
    INSPECTASSETGROUPSUM: 0xec,
    INSPECTOUTASSETCOUNT: 0xed,
    INSPECTOUTASSETAT: 0xee,
    INSPECTOUTASSETLOOKUP: 0xef,
    INSPECTINASSETCOUNT: 0xf0,
    INSPECTINASSETAT: 0xf1,
    INSPECTINASSETLOOKUP: 0xf2,
} as const;

export const ARKADE_OPCODE_NAMES: Record<number, string> = Object.fromEntries(
    Object.entries(ARKADE_OP).map(([name, value]) => [value, name])
);

export const ARKADE_OPCODE_VALUES: Record<string, number> = Object.fromEntries(
    Object.entries(ARKADE_OPCODE_NAMES).map(([value, name]) => [
        name,
        Number(value),
    ])
);

function buildBitcoinOpcodeNames(): Record<number, string> {
    const names: Record<number, string> = {};

    // Standard opcodes from @scure/btc-signer
    for (const [key, value] of Object.entries(OP)) {
        if (typeof value === "number") {
            // @scure uses names without OP_ prefix (e.g., "DUP", "HASH160")
            // We need to add OP_ prefix for consistency
            const name = key.startsWith("OP_") ? key : `OP_${key}`;
            names[value] = name;
        }
    }

    // Special case: OP_0 is stored as "OP_0" in @scure
    names[0x00] = "OP_0";

    return names;
}

function buildBitcoinOpcodeValues(): Record<string, number> {
    const values: Record<string, number> = {};

    for (const [key, value] of Object.entries(OP)) {
        if (typeof value === "number") {
            const name = key.startsWith("OP_") ? key : `OP_${key}`;
            values[name] = value;
            // Also support name without prefix
            values[key] = value;
        }
    }

    return values;
}

const BITCOIN_OPCODE_NAMES = buildBitcoinOpcodeNames();
const BITCOIN_OPCODE_VALUES = buildBitcoinOpcodeValues();

/**
 * Combined map from opcode value to name (with OP_ prefix)
 * Includes both Bitcoin and Arkade opcodes
 */
export const OPCODE_NAMES: Record<number, string> = {
    ...BITCOIN_OPCODE_NAMES,
    // Add Arkade opcodes with OP_ prefix
    ...Object.fromEntries(
        Object.entries(ARKADE_OPCODE_NAMES).map(([value, name]) => [
            Number(value),
            `OP_${name}`,
        ])
    ),
};

/**
 * Combined map from opcode name to value
 * Supports both with and without OP_ prefix
 * Includes both Bitcoin and Arkade opcodes
 */
export const OPCODE_VALUES: Record<string, number> = {
    ...BITCOIN_OPCODE_VALUES,
    // Add Arkade opcodes with and without OP_ prefix
    ...ARKADE_OPCODE_VALUES,
    ...Object.fromEntries(
        Object.entries(ARKADE_OPCODE_VALUES).map(([name, value]) => [
            `OP_${name}`,
            value,
        ])
    ),
};

/**
 * Get the name of an opcode from its value
 * Returns OP_DATA_N for data push opcodes (0x01-0x4b)
 *
 * @param value Opcode byte value
 * @returns Opcode name with OP_ prefix, or undefined if unknown
 */
export function getOpcodeName(value: number): string | undefined {
    // Handle data push opcodes (0x01-0x4b) as OP_DATA_N
    if (value >= 0x01 && value <= 0x4b) {
        return `OP_DATA_${value}`;
    }

    // Check combined mappings
    return OPCODE_NAMES[value];
}

/**
 * Get the value of an opcode from its name
 * Supports OP_DATA_N pattern for data push opcodes
 *
 * @param name Opcode name (with or without OP_ prefix)
 * @returns Opcode byte value, or undefined if unknown
 */
export function getOpcodeValue(name: string): number | undefined {
    // Handle OP_DATA_N pattern
    const dataMatch = name.match(/^OP_DATA_(\d+)$/);
    if (dataMatch) {
        const n = parseInt(dataMatch[1], 10);
        if (n >= 1 && n <= 75) {
            return n;
        }
        return undefined;
    }

    // Check combined mappings
    return OPCODE_VALUES[name];
}

/**
 * List of all Arkade opcodes (for iteration)
 */
export const ARKADE_OPCODES: number[] = Object.values(ARKADE_OP);
