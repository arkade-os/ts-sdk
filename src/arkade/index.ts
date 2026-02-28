/**
 * Arkade Script Support
 *
 * This module provides encoding/decoding support for Arkade script opcodes
 * and PSBT fields. It reuses @scure/btc-signer for all Bitcoin standard
 * functionality and only adds Arkade-specific extensions.
 *
 * ## Features
 * - Standard Bitcoin opcodes via @scure/btc-signer (re-exported as OP)
 * - Arkade extension opcodes (0xc4-0xf2)
 * - Script encoding/decoding via ScriptElement arrays
 * - ASM format conversion with Arkade opcode support
 *
 * @module arkade
 */

// Re-export standard Bitcoin Script and opcodes from @scure/btc-signer
import { OP, Script, type ScriptType } from "@scure/btc-signer";
export { OP, Script, type ScriptType };

export {
    ARKADE_OP,
    ARKADE_OPCODE_NAMES,
    ARKADE_OPCODE_VALUES,
    OPCODE_NAMES,
    OPCODE_VALUES,
    ARKADE_OPCODES,
    getOpcodeName,
    getOpcodeValue,
} from "./opcodes";

// Export ArkadeScript CoderType (same API as @scure/btc-signer Script, with Arkade opcodes)
export {
    ArkadeScript,
    type ArkadeScriptType,
    type ArkadeScriptOP,
    ARKADE_OPS,
} from "./script";

export { toASM, fromASM, asmToBytes, bytesToASM } from "./script";
export { arkadeScriptHash, computeArkadeScriptPublicKey } from "./tweak";
export { createArkadeBatchHandler, type ArkadeExtendedCoin } from "./batch";
export {
    ArkadeVtxoScript,
    type ArkadeLeaf,
    type ArkadeVtxoInput,
} from "./vtxoScript";
