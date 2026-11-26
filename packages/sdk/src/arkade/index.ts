/**
 * Arkade Script Support
 *
 * This module provides encoding/decoding support for Arkade script opcodes
 * and PSBT fields. It reuses @scure/btc-signer for all Bitcoin standard
 * functionality and only adds Arkade-specific extensions.
 *
 * ## Features
 * - Standard Bitcoin opcodes via @scure/btc-signer (re-exported as OP)
 * - Arkade extension opcodes (0xb3, 0xc4-0xf3)
 * - Script encoding/decoding via ScriptElement arrays
 * - ASM format conversion with Arkade opcode support
 *
 * @module arkade
 */

// Re-export standard Bitcoin Script and opcodes from @scure/btc-signer
import { OP, Script, type ScriptType as BitcoinScriptType } from "@scure/btc-signer";
import type {
    ArkadeArgType as ProgramArgType,
    ArkadeArgValue as ProgramArgValue,
    ArkadeContractParams as ProgramContractParams,
    ArkadeFunction as ProgramFunction,
    ArkadeParamValue as ProgramParamValue,
    ArkadeSegment as ProgramSegment,
    AsmToken as ProgramAsmToken,
    CompiledProgramFunction as ProgramCompiledFunction,
    InputDef as ProgramInputDef,
    InputRef as ProgramInputRef,
    Program as ProgramDefinition,
    ProgramKeys as ProgramKeySet,
    SignerRef as ProgramSignerRef,
    SourceRange as ProgramSourceRange,
    TapscriptSegment as ProgramTapscriptSegment,
    TweakedSigner as ProgramTweakedSigner,
    WitnessRef as ProgramWitnessRef,
} from "./program";
import type {
    ArkadeService as ServiceDefinition,
    ResolvedArkadeService as ResolvedService,
} from "./service";
export { OP, Script };

// Local aliases keep namespace declaration bundling from treating shared-chunk
// types as runtime values.
export type ScriptType = BitcoinScriptType;
export type ArkadeArgType = ProgramArgType;
export type ArkadeArgValue = ProgramArgValue;
export type ArkadeContractParams = ProgramContractParams;
export type ArkadeFunction = ProgramFunction;
export type ArkadeParamValue = ProgramParamValue;
export type ArkadeSegment = ProgramSegment;
export type AsmToken = ProgramAsmToken;
export type CompiledProgramFunction = ProgramCompiledFunction;
export type InputDef = ProgramInputDef;
export type InputRef = ProgramInputRef;
export type Program = ProgramDefinition;
export type ProgramKeys = ProgramKeySet;
export type SignerRef = ProgramSignerRef;
export type SourceRange = ProgramSourceRange;
export type TapscriptSegment = ProgramTapscriptSegment;
export type TweakedSigner = ProgramTweakedSigner;
export type WitnessRef = ProgramWitnessRef;
export type ArkadeService = ServiceDefinition;
export type ResolvedArkadeService = ResolvedService;

export {
    ARKADE_OP,
    ARKADE_OPCODES,
    ARKADE_OPCODE_NAMES,
    ARKADE_OPCODE_VALUES,
    OPCODE_NAMES,
    OPCODE_VALUES,
    getOpcodeName,
    getOpcodeValue,
} from "./opcodes";

// Export ArkadeScript CoderType (same API as @scure/btc-signer Script, with Arkade opcodes)
export { ArkadeScript, type ArkadeScriptType, type ArkadeScriptOP, ARKADE_OPS } from "./script";

export { toASM, fromASM, asmToBytes, bytesToASM } from "./script";
export { arkadeScriptHash, arkadeWitnessHash, computeArkadeScriptPublicKey } from "./tweak";
export * as BigNum from "./bignum";
export {
    createArkadeBatchHandler,
    type ArkadeBatchInput,
    type ArkadeExtendedCoin,
    type ArkadeExtendedVirtualCoin,
} from "./batch";
export { renewProgramContractOutputs, type ProgramContractRenewTarget } from "./renew";
export {
    programFromArtifact,
    isContractArtifact,
    type ContractArtifact,
    type ContractDebugInfo,
    type ProgramFromArtifactOptions,
} from "./artifact";
export {
    ArkadeProgramScript,
    stringifyArtifact,
    serializeArkadeContractParams,
    deserializeArkadeContractParams,
    witnessRefToBytes,
    UnsupportedProgramVersionError,
} from "./program";
export {
    Arkade,
    ArkadeContract,
    ArkadeTransactionBuilder,
    resolveAsm,
    parseArtifact,
    validateProgram,
    SUPPORTED_PROGRAM_VERSION,
    type AssetSpec,
    type ArkadeNestedValue,
    type Utxo,
    type ArkadeUnlocker,
    type ArkadeSpendResult,
    type CallableFunctions,
    type ContractFunctions,
    type ContractUnlockers,
    type ArkadeConnectOptions,
    type ArkadeConnectServiceOptions,
    type ArkadeConnectProviderOptions,
    type ArkadeContractEventType,
    type ArkadeContractEvent,
    type ArkadeContractSubscription,
    type ArkadeServerProvider,
} from "./contract";
export { resolveArkadeService } from "./service";
