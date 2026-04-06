export { verifyVtxo, verifyAllVtxos } from "./vtxoChainVerifier";
export type {
    VtxoVerificationResult,
    VtxoVerificationOptions,
} from "./vtxoChainVerifier";

export {
    verifyTreeSignatures,
    verifyCosignerKeys,
    verifyInternalKeysUnspendable,
} from "./signatureVerifier";
export type {
    SignatureVerificationResult,
    CosignerKeyVerificationResult,
    InternalKeyVerificationResult,
} from "./signatureVerifier";

export { verifyOnchainAnchor } from "./onchainAnchorVerifier";
export type { AnchorVerification } from "./onchainAnchorVerifier";

export {
    verifyCheckpointTransactions,
    verifyCheckpointTimelocks,
} from "./checkpointVerifier";
export type {
    CheckpointVerificationResult,
    CheckpointTimelockResult,
} from "./checkpointVerifier";

export {
    verifyTaprootScriptTree,
    verifyCSV,
    verifyCLTV,
    verifyHashPreimage,
    verifyScriptSatisfaction,
} from "./scriptVerifier";
export type {
    ScriptVerificationResult,
    ChainTip,
    ParentConfirmation,
} from "./scriptVerifier";

export {
    verifyBoltzSwapPreimage,
    verifyBoltzSwapSatisfaction,
} from "./swapVerifier";

export {
    collectExitData,
    validateExitData,
    InMemoryExitDataRepository,
} from "./exitDataStore";
export type { ExitData, ExitDataRepository } from "./exitDataStore";

export {
    StorageAdapterExitDataRepository,
    FileSystemExitDataRepository,
    IndexedDBExitDataRepository,
    AsyncStorageExitDataRepository,
} from "./exitDataRepository";

export {
    buildExitDataForVtxo,
    buildExitDataForVtxos,
    syncExitData,
} from "./exitDataSync";

export { sovereignExit, canSovereignExit } from "./sovereignExit";
export type {
    SovereignExitStep,
    SovereignExitResult,
    SovereignExitOptions,
} from "./sovereignExit";

export { buildVtxoDAG, renderDAGAscii } from "./dagVisualizer";
export type { DAGNode, DAGEdge, VtxoDAG } from "./dagVisualizer";
