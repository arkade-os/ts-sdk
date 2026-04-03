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
    collectExitData,
    validateExitData,
    InMemoryExitDataRepository,
} from "./exitDataStore";
export type { ExitData, ExitDataRepository } from "./exitDataStore";

export { sovereignExit, canSovereignExit } from "./sovereignExit";
export type { SovereignExitStep, SovereignExitResult } from "./sovereignExit";

export { buildVtxoDAG, renderDAGAscii } from "./dagVisualizer";
export type { DAGNode, DAGEdge, VtxoDAG } from "./dagVisualizer";
