export { type CovenantOptions, executeCovenant } from "./arkadeScript";
export { BigNum } from "./bignum";
export {
    EmulationError,
    emulateBatchRegistration,
    emulateOffchainTx,
    emulateOnchainTx,
    type ServiceOptions,
    type SignRequest,
    type VtxoExpiries,
} from "./emulate";
export {
    Engine,
    type EngineOptions,
    type ExpressionOptions,
    evalExpression,
    newEngine,
    type TapLeaf,
} from "./engine";
export {
    type ArkadeErrorCode,
    ErrUnsupportedByPort,
    ExecutionError,
    KIND,
    ScriptError,
} from "./errors";
export { type ArkPrevOutFetcher, MapArkPrevOutFetcher } from "./fetcher";
export { type DraftSource, draftFetcher } from "./fetchers-ark";
export {
    ComputeBudget,
    type ComputeLimits,
    DefaultComputeLimits,
    MaxScriptElementSize,
    MaxScriptSize,
} from "./limits";
export type { Opcode } from "./opcodes";
export { OpcodeByName } from "./opnames";
export { isExtensionScript, ScriptTokenizer } from "./tokenizer";
// the serializers and txid stay because src/arkade/template builds transactions with them
export {
    type OutPoint,
    parseTx,
    serializeTx,
    serializeTxOut,
    serializeTxStripped,
    serializeWitness,
    txid,
    type VmTx,
    type VmTxIn,
    type VmTxOut,
} from "./tx";
export type * from "./types";
