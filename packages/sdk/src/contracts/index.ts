// Types
export * from "./types";

// Contract handlers
export { contractHandlers } from "./handlers";
export { DefaultContractHandler } from "./handlers";
export type { DefaultContractParams } from "./handlers";
export { DelegateContractHandler } from "./handlers";
export type { DelegateContractParams } from "./handlers";
export { VHTLCContractHandler } from "./handlers";
export type { VHTLCContractParams } from "./handlers";
export { VHTLCV2ContractHandler } from "./handlers";
export type { VHTLCV2ContractParams } from "./handlers";
export { BoardingContractHandler } from "./handlers";
export type { BoardingContractParams } from "./handlers";

// Generic-spending gate
export {
    isContractGenericallySpendable,
    gatedContracts,
    gateExclusion,
    outpointExclusion,
    outpointReasons,
    logExcludedVtxos,
    UnannotatableInputError,
} from "./spendability";
export type { ExcludableVtxo, VtxoExclusion } from "./spendability";

// arkcontract string codec
export {
    encodeArkadeContract,
    decodeArkadeContract,
    contractFromArkadeContract,
    contractFromArkadeContractWithAddress,
    isArkadeContract,
} from "./arkadeContract";
export type { ParsedArkadeContract } from "./arkadeContract";

// Contract watcher
export { ContractWatcher } from "./contractWatcher";
export type { ContractWatcherConfig, ContractWatcherEventCallback } from "./contractWatcher";

// Contract manager
export { ContractManager } from "./contractManager";
export type {
    ContractManagerConfig,
    CreateContractParams,
    RefreshVtxosOptions,
    ScanResult,
    ScanContractsOptions,
    HandlerError,
} from "./contractManager";
