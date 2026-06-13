import { Transaction } from "./utils/transaction";
import { SingleKey, ReadonlySingleKey } from "./identity/singleKey";
import {
    SeedIdentity,
    MnemonicIdentity,
    ReadonlyDescriptorIdentity,
} from "./identity/seedIdentity";
import type {
    SeedIdentityOptions,
    MnemonicOptions,
    NetworkOptions,
    DescriptorOptions,
} from "./identity/seedIdentity";
import {
    Identity,
    ReadonlyIdentity,
    BatchSignableIdentity,
    SignRequest,
    isBatchSignable,
} from "./identity";
import { ArkAddress } from "./script/address";
import { VHTLC } from "./script/vhtlc";
import { DefaultVtxo } from "./script/default";
import { DelegateVtxo } from "./script/delegate";
import { MessageHandler, RequestEnvelope, ResponseEnvelope, MessageBus } from "./worker/messageBus";
import {
    VtxoScript,
    EncodedVtxoScript,
    TapLeafScript,
    TapTreeCoder,
    getSequence,
} from "./script/base";
import { assembleBtcdTaprootTree } from "./script/taprootTree";
import {
    TxType,
    IWallet,
    IReadonlyWallet,
    BaseWalletConfig,
    WalletConfig,
    WalletMode,
    ReadonlyWalletConfig,
    ProviderClass,
    ArkTransaction,
    Coin,
    ExtendedCoin,
    ExtendedVirtualCoin,
    WalletBalance,
    SendBitcoinParams,
    SettleParams,
    Status,
    VirtualStatus,
    Outpoint,
    VirtualCoin,
    TxKey,
    GetVtxosFilter,
    TapLeaves,
    StorageConfig,
    isSpendable,
    isSubdust,
    isRecoverable,
    isExpired,
    // Asset types
    Asset,
    Recipient,
    IssuanceParams,
    IssuanceResult,
    ReissuanceParams,
    BurnParams,
    AssetDetails,
    AssetMetadata,
    KnownMetadata,
    IAssetManager,
    IReadonlyAssetManager,
} from "./wallet";
import { Batch } from "./wallet/batch";
import {
    Wallet,
    ReadonlyWallet,
    waitForIncomingFunds,
    IncomingFunds,
    BoardingUtxoGroup,
    DescriptorSigningProviderMissingError,
    MissingSigningDescriptorError,
} from "./wallet/wallet";
import { TxTree, TxTreeNode } from "./tree/txTree";
import { SignerSession, TreeNonces, TreePartialSigs } from "./tree/signingSession";
import { DustChangeError, Ramps } from "./wallet/ramps";
import { HDDescriptorProvider } from "./wallet/hdDescriptorProvider";
import { isVtxoExpiringSoon, VtxoManager } from "./wallet/vtxo-manager";
import type {
    IVtxoManager,
    RenewVtxosOptions,
    SettlementConfig,
    MigrateDeprecatedSignerOptions,
    DeprecatedSignerMigrationReport,
    DeprecatedSignerReport,
    MigrationVtxoRef,
    MigrationLegReport,
    MigrationLegSkipReason,
    MigrationGlobalSkipReason,
} from "./wallet/vtxo-manager";
import {
    classifyContractSigner,
    classifyAgainstSignerSet,
    signerSetFromInfo,
    isCooperativelyMigratable,
    toXOnlySignerHex,
} from "./wallet/signerRotation";
import type { SignerStatus, SignerClassification, SignerSet } from "./wallet/signerRotation";
import {
    ServiceWorkerWallet,
    ServiceWorkerReadonlyWallet,
    DEFAULT_MESSAGE_TIMEOUTS,
} from "./wallet/serviceWorker/wallet";
import type { MessageTimeouts, ServiceWorkerWalletMode } from "./wallet/serviceWorker/wallet";
import { OnchainWallet } from "./wallet/onchain";
import { setupServiceWorker } from "./worker/browser/utils";
import {
    ESPLORA_URL,
    EsploraProvider,
    OnchainProvider,
    ExplorerTransaction,
} from "./providers/onchain";
import {
    ELECTRUM_TCP_HOST,
    ELECTRUM_WS_URL,
    ElectrumOnchainProvider,
    WsElectrumChainSource,
} from "./providers/electrum";
import type {
    TransactionHistory as ElectrumTransactionHistory,
    BlockHeader as ElectrumBlockHeader,
    Unspent as ElectrumUnspent,
} from "./providers/electrum";
import {
    RestArkProvider,
    ArkProvider,
    SettlementEvent,
    SettlementEventType,
    ArkInfo,
    SignedIntent,
    Output,
    TxNotification,
    BatchFinalizationEvent,
    BatchFinalizedEvent,
    BatchFailedEvent,
    TreeSigningStartedEvent,
    TreeNoncesEvent,
    BatchStartedEvent,
    TreeTxEvent,
    TreeSignatureEvent,
    ScheduledSession,
    FeeInfo,
} from "./providers/ark";
import {
    DelegateProvider,
    DelegatorProvider,
    DelegateInfo,
    DelegateOptions,
    RestDelegateProvider,
    RestDelegatorProvider,
} from "./providers/delegate";
import {
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    decodeTapscript,
    MultisigTapscript,
    TapscriptType,
    ArkTapscript,
    RelativeTimelock,
} from "./script/tapscript";
import {
    hasBoardingTxExpired,
    buildOffchainTx,
    verifyTapscriptSignatures,
    ArkTxInput,
    OffchainTx,
    combineTapscriptSigs,
    isValidArkAddress,
} from "./utils/arkTransaction";
import { getRandomId } from "./wallet/utils";
import {
    VtxoTaprootTree,
    ConditionWitness,
    getArkPsbtFields,
    setArkPsbtField,
    ArkPsbtFieldCoder,
    ArkPsbtFieldKey,
    ArkPsbtFieldKeyType,
    CosignerPublicKey,
    VtxoTreeExpiry,
} from "./utils/unknownFields";
import { Intent } from "./intent";
import { BIP322 } from "./bip322";
import { ArkNote } from "./arknote";
import { networks, Network, NetworkName } from "./networks";
import {
    RestIndexerProvider,
    IndexerProvider,
    IndexerTxType,
    ChainTxType,
    PageResponse,
    BatchInfo,
    ChainTx,
    CommitmentTx,
    TxHistoryRecord,
    VtxoChain,
    Tx,
    Vtxo,
    PaginationOptions,
    SubscriptionResponse,
    SubscriptionHeartbeat,
    SubscriptionEvent,
} from "./providers/indexer";
import { Nonces } from "./musig2/nonces";
import { PartialSig } from "./musig2/sign";
import { AnchorBumper, P2A } from "./utils/anchor";
import { TxWeightEstimator, type VSize } from "./utils/txSizeEstimator";
import { Unroll } from "./wallet/unroll";
import { ArkError, maybeArkError } from "./providers/errors";
import { validateVtxoTxGraph, validateConnectorsTxGraph } from "./tree/validation";
import { buildForfeitTx } from "./forfeit";
import { IndexedDBWalletRepository } from "./repositories/indexedDB/walletRepository";
import { IndexedDBContractRepository } from "./repositories/indexedDB/contractRepository";
import { InMemoryWalletRepository } from "./repositories/inMemory/walletRepository";
import { InMemoryContractRepository } from "./repositories/inMemory/contractRepository";
import {
    MIGRATION_KEY,
    migrateWalletRepository,
    requiresMigration,
    getMigrationStatus,
    rollbackMigration,
} from "./repositories/migrations/fromStorageAdapter";
import type { MigrationStatus } from "./repositories/migrations/fromStorageAdapter";
import { WalletRepositoryImpl } from "./repositories/migrations/walletRepositoryImpl";
import { ContractRepositoryImpl } from "./repositories/migrations/contractRepositoryImpl";
import type { WalletRepository } from "./repositories/walletRepository";
import type { ContractRepository } from "./repositories/contractRepository";
import {
    DelegateManagerImpl,
    DelegatorManagerImpl,
    IDelegateManager,
    IDelegatorManager,
} from "./wallet/delegate";

export * from "./arkfee";
export * as asset from "./extension/asset";

// Contracts
// Side-effect import: registers the built-in handlers with `contractHandlers`.
// Kept as a bare import so the registration runs even though the named
// re-export path through `./contracts/index.ts` is intentionally avoided
// (the barrel re-exports caused Rollup chunk-circularity warnings in the
// dts emit when combined with tsup's splitting).
import "./contracts/handlers";
import { ContractManager } from "./contracts/contractManager";
import type {
    IContractManager,
    ContractManagerConfig,
    CreateContractParams,
} from "./contracts/contractManager";
import { ContractWatcher } from "./contracts/contractWatcher";
import type { ContractWatcherConfig } from "./contracts/contractWatcher";
import { contractHandlers } from "./contracts/handlers/registry";
import { DefaultContractHandler } from "./contracts/handlers/default";
import type { DefaultContractParams } from "./contracts/handlers/default";
import { DelegateContractHandler } from "./contracts/handlers/delegate";
import type { DelegateContractParams } from "./contracts/handlers/delegate";
import { VHTLCContractHandler } from "./contracts/handlers/vhtlc";
import type { VHTLCContractParams } from "./contracts/handlers/vhtlc";
import { isCsvSpendable, isCltvSatisfied } from "./contracts/handlers/helpers";
import { BoardingContractHandler } from "./contracts/handlers/boarding";
import type { BoardingContractParams } from "./contracts/handlers/boarding";
import {
    encodeArkContract,
    decodeArkContract,
    contractFromArkContract,
    contractFromArkContractWithAddress,
    isArkContract,
} from "./contracts/arkcontract";
import type { ParsedArkContract } from "./contracts/arkcontract";
import { isDiscoverable } from "./contracts/types";
import type {
    Contract,
    ContractVtxo,
    ContractState,
    ContractEvent,
    ContractEventCallback,
    ContractBalance,
    ContractWithVtxos,
    ContractHandler,
    PathSelection,
    PathContext,
    ExtendedContractVtxo,
    Discoverable,
    DiscoveryDeps,
    DiscoveredContract,
} from "./contracts/types";
import type { ScanResult, ScanContractsOptions, HandlerError } from "./contracts/contractManager";
import { timelockToSequence, sequenceToTimelock } from "./utils/timelock";
import { closeDatabase, openDatabase } from "./repositories/indexedDB/manager";
import {
    WalletMessageHandler,
    WalletNotInitializedError,
    ReadonlyWalletError,
    DelegateNotConfiguredError,
    DelegatorNotConfiguredError,
} from "./wallet/serviceWorker/wallet-message-handler";
import {
    MESSAGE_BUS_NOT_INITIALIZED,
    MessageBusNotInitializedError,
    ServiceWorkerTimeoutError,
} from "./worker/errors";
import { AssetManager, ReadonlyAssetManager } from "./wallet/asset-manager";

export {
    // Wallets
    Wallet,
    ReadonlyWallet,
    SingleKey,
    ReadonlySingleKey,
    SeedIdentity,
    MnemonicIdentity,
    ReadonlyDescriptorIdentity,
    isBatchSignable,
    OnchainWallet,
    Ramps,
    DustChangeError,
    VtxoManager,
    classifyContractSigner,
    classifyAgainstSignerSet,
    signerSetFromInfo,
    isCooperativelyMigratable,
    toXOnlySignerHex,
    HDDescriptorProvider,
    DelegateManagerImpl,
    DelegatorManagerImpl,
    RestDelegateProvider,
    RestDelegatorProvider,

    // Providers
    ESPLORA_URL,
    EsploraProvider,
    ELECTRUM_WS_URL,
    ELECTRUM_TCP_HOST,
    ElectrumOnchainProvider,
    WsElectrumChainSource,
    RestArkProvider,
    RestIndexerProvider,

    // Script-related
    ArkAddress,
    DefaultVtxo,
    DelegateVtxo,
    VtxoScript,
    VHTLC,
    assembleBtcdTaprootTree,

    // Enums
    TxType,
    IndexerTxType,
    ChainTxType,
    SettlementEventType,

    // Service Worker
    setupServiceWorker,
    MessageBus,
    WalletMessageHandler,
    WalletNotInitializedError,
    ReadonlyWalletError,
    DelegateNotConfiguredError,
    DelegatorNotConfiguredError,
    MESSAGE_BUS_NOT_INITIALIZED,
    MessageBusNotInitializedError,
    ServiceWorkerTimeoutError,
    ServiceWorkerWallet,
    ServiceWorkerReadonlyWallet,
    DEFAULT_MESSAGE_TIMEOUTS,

    // Tapscript
    decodeTapscript,
    MultisigTapscript,
    CSVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    CLTVMultisigTapscript,
    TapTreeCoder,

    // Arkade PSBT fields
    ArkPsbtFieldKey,
    ArkPsbtFieldKeyType,
    setArkPsbtField,
    getArkPsbtFields,
    CosignerPublicKey,
    VtxoTreeExpiry,
    VtxoTaprootTree,
    ConditionWitness,

    // Utils
    buildOffchainTx,
    verifyTapscriptSignatures,
    waitForIncomingFunds,
    hasBoardingTxExpired,
    combineTapscriptSigs,
    isVtxoExpiringSoon,
    isValidArkAddress,
    getRandomId,

    // Arknote
    ArkNote,

    // Network
    networks,

    // DB
    closeDatabase,
    openDatabase,

    // Repositories
    IndexedDBWalletRepository,
    IndexedDBContractRepository,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    MIGRATION_KEY,
    migrateWalletRepository,
    requiresMigration,
    getMigrationStatus,
    rollbackMigration,
    WalletRepositoryImpl,
    ContractRepositoryImpl,

    // Intent proof
    Intent,

    // BIP-322 message signing
    BIP322,

    // TxTree
    TxTree,

    // Anchor
    P2A,
    Unroll,
    Transaction,
    TxWeightEstimator,
    timelockToSequence,
    sequenceToTimelock,

    // Errors
    ArkError,
    maybeArkError,
    DescriptorSigningProviderMissingError,
    MissingSigningDescriptorError,

    // Batch session
    Batch,
    validateVtxoTxGraph,
    validateConnectorsTxGraph,
    buildForfeitTx,
    isRecoverable,
    isSpendable,
    isSubdust,
    isExpired,
    getSequence,

    // Contracts
    ContractManager,
    ContractWatcher,
    contractHandlers,
    DefaultContractHandler,
    DelegateContractHandler,
    VHTLCContractHandler,
    BoardingContractHandler,
    encodeArkContract,
    decodeArkContract,
    contractFromArkContract,
    contractFromArkContractWithAddress,
    isArkContract,
    isDiscoverable,
    // Contract handler authoring helpers (spending-path selection)
    isCsvSpendable,
    isCltvSatisfied,

    // Assets
    ReadonlyAssetManager,
    AssetManager,
};

export type {
    // Types and Interfaces
    Identity,
    ReadonlyIdentity,
    BatchSignableIdentity,
    SignRequest,
    IWallet,
    IReadonlyWallet,
    BaseWalletConfig,
    WalletConfig,
    WalletMode,
    ReadonlyWalletConfig,
    ProviderClass,
    ArkTransaction,
    Coin,
    ExtendedCoin,
    ExtendedVirtualCoin,
    WalletBalance,
    SendBitcoinParams,
    SettleParams,
    Status,
    VirtualStatus,
    Outpoint,
    VirtualCoin,
    TxKey,
    TapscriptType,
    ArkTxInput,
    OffchainTx,
    TapLeaves,
    IncomingFunds,

    // Identity options
    SeedIdentityOptions,
    MnemonicOptions,
    NetworkOptions,
    DescriptorOptions,
    // Indexer types
    IndexerProvider,
    PageResponse,
    BatchInfo,
    ChainTx,
    CommitmentTx,
    TxHistoryRecord,
    Vtxo,
    VtxoChain,
    Tx,

    // Provider types
    OnchainProvider,
    ArkProvider,
    SettlementEvent,
    FeeInfo,
    ArkInfo,
    SignedIntent,
    Output,
    TxNotification,
    ExplorerTransaction,
    ElectrumTransactionHistory,
    ElectrumBlockHeader,
    ElectrumUnspent,
    BatchFinalizationEvent,
    BatchFinalizedEvent,
    BatchFailedEvent,
    TreeSigningStartedEvent,
    TreeNoncesEvent,
    BatchStartedEvent,
    TreeTxEvent,
    TreeSignatureEvent,
    ScheduledSession,
    PaginationOptions,
    SubscriptionResponse,
    SubscriptionHeartbeat,
    SubscriptionEvent,

    // Network types
    Network,
    NetworkName,

    // Script types
    ArkTapscript,
    RelativeTimelock,
    EncodedVtxoScript,
    TapLeafScript,

    // Tree types
    SignerSession,
    TreeNonces,
    TreePartialSigs,

    // Wallet types
    GetVtxosFilter,
    BoardingUtxoGroup,
    SettlementConfig,
    IVtxoManager,
    RenewVtxosOptions,
    MigrateDeprecatedSignerOptions,
    DeprecatedSignerMigrationReport,
    DeprecatedSignerReport,
    MigrationVtxoRef,
    MigrationLegReport,
    MigrationLegSkipReason,
    MigrationGlobalSkipReason,
    SignerStatus,
    SignerClassification,
    SignerSet,

    // Asset types
    IReadonlyAssetManager,
    IAssetManager,
    Asset,
    Recipient,
    IssuanceParams,
    IssuanceResult,
    ReissuanceParams,
    BurnParams,
    AssetDetails,
    AssetMetadata,
    KnownMetadata,

    // Musig2 types
    Nonces,
    PartialSig,

    // Arkade PSBT field coder
    ArkPsbtFieldCoder,

    // TxTree
    TxTreeNode,

    // Anchor
    AnchorBumper,
    VSize,

    // Storage
    StorageConfig,

    // Contract types
    Contract,
    ContractVtxo,
    ContractState,
    ContractEvent,
    ContractEventCallback,
    ContractBalance,
    ContractWithVtxos,
    ContractHandler,
    IContractManager,
    PathSelection,
    ExtendedContractVtxo,
    PathContext,
    ContractManagerConfig,
    CreateContractParams,
    ContractWatcherConfig,
    ParsedArkContract,
    DefaultContractParams,
    DelegateContractParams,
    VHTLCContractParams,
    BoardingContractParams,
    Discoverable,
    DiscoveryDeps,
    DiscoveredContract,
    ScanResult,
    ScanContractsOptions,
    HandlerError,

    // Service Worker types
    MessageHandler,
    RequestEnvelope,
    ResponseEnvelope,
    MessageTimeouts,
    ServiceWorkerWalletMode,

    // Delegate types (Delegator* aliases deprecated)
    IDelegateManager,
    IDelegatorManager,
    DelegateProvider,
    DelegatorProvider,
    DelegateInfo,
    DelegateOptions,

    // Repositories
    WalletRepository,
    ContractRepository,
    MigrationStatus,
};
