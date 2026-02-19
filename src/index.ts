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
import { Identity, ReadonlyIdentity } from "./identity";
import { ArkAddress } from "./script/address";
import { VHTLC } from "./script/vhtlc";
import { DefaultVtxo } from "./script/default";
import { DelegateVtxo } from "./script/delegate";
import {
    MessageHandler,
    RequestEnvelope,
    ResponseEnvelope,
    MessageBus,
} from "./worker/messageBus";
import {
    VtxoScript,
    EncodedVtxoScript,
    TapLeafScript,
    TapTreeCoder,
    getSequence,
} from "./script/base";
import {
    TxType,
    IWallet,
    IReadonlyWallet,
    BaseWalletConfig,
    WalletConfig,
    ReadonlyWalletConfig,
    ProviderClass,
    ArkTransaction,
    Coin,
    ExtendedCoin,
    ExtendedVirtualCoin,
    WalletBalance,
    SendBitcoinParams,
    Recipient,
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
} from "./wallet";
import { Batch } from "./wallet/batch";
import {
    Wallet,
    ReadonlyWallet,
    waitForIncomingFunds,
    IncomingFunds,
} from "./wallet/wallet";
import { TxTree, TxTreeNode } from "./tree/txTree";
import {
    SignerSession,
    TreeNonces,
    TreePartialSigs,
} from "./tree/signingSession";
import { Ramps } from "./wallet/ramps";
import { isVtxoExpiringSoon, VtxoManager } from "./wallet/vtxo-manager";
import {
    ServiceWorkerWallet,
    ServiceWorkerReadonlyWallet,
} from "./wallet/serviceWorker/wallet";
import { OnchainWallet } from "./wallet/onchain";
import { setupServiceWorker } from "./worker/browser/utils";
import {
    ESPLORA_URL,
    EsploraProvider,
    OnchainProvider,
    ExplorerTransaction,
} from "./providers/onchain";
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
    DelegatorProvider,
    DelegateInfo,
    DelegateOptions,
    RestDelegatorProvider,
} from "./providers/delegator";
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
} from "./utils/arkTransaction";
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
import { Unroll } from "./wallet/unroll";
import { ArkError, maybeArkError } from "./providers/errors";
import {
    validateVtxoTxGraph,
    validateConnectorsTxGraph,
} from "./tree/validation";
import { buildForfeitTx } from "./forfeit";
import {
    IndexedDBWalletRepository,
    IndexedDBContractRepository,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    migrateWalletRepository,
    WalletRepositoryImpl,
    ContractRepositoryImpl,
    WalletRepository,
    ContractRepository,
} from "./repositories";
import { DelegatorManagerImpl, DelegatorManager } from "./wallet/delegator";

export * from "./arkfee";

// Contracts
import {
    ContractManager,
    ContractWatcher,
    contractHandlers,
    DefaultContractHandler,
    DelegateContractHandler,
    VHTLCContractHandler,
    encodeArkContract,
    decodeArkContract,
    contractFromArkContract,
    contractFromArkContractWithAddress,
    isArkContract,
} from "./contracts";
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
    ContractManagerConfig,
    CreateContractParams,
    ContractWatcherConfig,
    ParsedArkContract,
    DefaultContractParams,
    DelegateContractParams,
    VHTLCContractParams,
} from "./contracts";
import { IContractManager } from "./contracts/contractManager";
import { closeDatabase, openDatabase } from "./db/manager";
import { WalletMessageHandler } from "./wallet/serviceWorker/wallet-message-handler";

export {
    // Wallets
    Wallet,
    ReadonlyWallet,
    SingleKey,
    ReadonlySingleKey,
    SeedIdentity,
    MnemonicIdentity,
    ReadonlyDescriptorIdentity,
    OnchainWallet,
    Ramps,
    VtxoManager,
    DelegatorManagerImpl,
    RestDelegatorProvider,

    // Providers
    ESPLORA_URL,
    EsploraProvider,
    RestArkProvider,
    RestIndexerProvider,

    // Script-related
    ArkAddress,
    DefaultVtxo,
    DelegateVtxo,
    VtxoScript,
    VHTLC,

    // Enums
    TxType,
    IndexerTxType,
    ChainTxType,
    SettlementEventType,

    // Service Worker
    setupServiceWorker,
    MessageBus,
    WalletMessageHandler,
    ServiceWorkerWallet,
    ServiceWorkerReadonlyWallet,

    // Tapscript
    decodeTapscript,
    MultisigTapscript,
    CSVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    CLTVMultisigTapscript,
    TapTreeCoder,

    // Ark PSBT fields
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
    migrateWalletRepository,
    WalletRepositoryImpl,
    ContractRepositoryImpl,

    // Intent proof
    Intent,

    // TxTree
    TxTree,

    // Anchor
    P2A,
    Unroll,
    Transaction,

    // Errors
    ArkError,
    maybeArkError,

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
    encodeArkContract,
    decodeArkContract,
    contractFromArkContract,
    contractFromArkContractWithAddress,
    isArkContract,
};

export type {
    // Types and Interfaces
    Identity,
    ReadonlyIdentity,
    IWallet,
    IReadonlyWallet,
    BaseWalletConfig,
    WalletConfig,
    ReadonlyWalletConfig,
    ProviderClass,
    ArkTransaction,
    Coin,
    ExtendedCoin,
    ExtendedVirtualCoin,
    WalletBalance,
    SendBitcoinParams,
    Recipient,
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

    // Musig2 types
    Nonces,
    PartialSig,

    // Ark PSBT fields
    ArkPsbtFieldCoder,

    // TxTree
    TxTreeNode,

    // Anchor
    AnchorBumper,

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
    PathContext,
    ContractManagerConfig,
    CreateContractParams,
    ContractWatcherConfig,
    ParsedArkContract,
    DefaultContractParams,
    DelegateContractParams,
    VHTLCContractParams,

    // Service Worker types
    MessageHandler,
    RequestEnvelope,
    ResponseEnvelope,

    // Delegator types
    DelegatorManager,
    DelegatorProvider,
    DelegateInfo,
    DelegateOptions,

    // Repositories
    WalletRepository,
    ContractRepository,
};
