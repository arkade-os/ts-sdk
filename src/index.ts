import { Transaction } from "./utils/transaction";
import { SingleKey, ReadonlySingleKey } from "./identity/singleKey";
import { Identity, ReadonlyIdentity } from "./identity";
import { ArkAddress } from "./script/address";
import { VHTLC } from "./script/vhtlc";
import { DefaultVtxo } from "./script/default";
import {
    VtxoScript,
    EncodedVtxoScript,
    TapLeafScript,
    TapTreeCoder,
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
    getSequence,
} from "./wallet/wallet";
import { TxTree, TxTreeNode } from "./tree/txTree";
import {
    SignerSession,
    TreeNonces,
    TreePartialSigs,
} from "./tree/signingSession";
import { Ramps } from "./wallet/ramps";
import { isVtxoExpiringSoon, VtxoManager } from "./wallet/vtxo-manager";
import { ServiceWorkerWallet } from "./wallet/serviceWorker/wallet";
import { OnchainWallet } from "./wallet/onchain";
import { setupServiceWorker } from "./wallet/serviceWorker/utils";
import { Worker } from "./wallet/serviceWorker/worker";
import { Request } from "./wallet/serviceWorker/request";
import { Response } from "./wallet/serviceWorker/response";
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
import { WalletRepositoryImpl } from "./repositories/walletRepository";
import { ContractRepositoryImpl } from "./repositories/contractRepository";
import { ArkError, maybeArkError } from "./providers/errors";
import {
    validateVtxoTxGraph,
    validateConnectorsTxGraph,
} from "./tree/validation";
import { buildForfeitTx } from "./forfeit";

export {
    // Wallets
    Wallet,
    ReadonlyWallet,
    SingleKey,
    ReadonlySingleKey,
    OnchainWallet,
    Ramps,
    VtxoManager,

    // Providers
    ESPLORA_URL,
    EsploraProvider,
    RestArkProvider,
    RestIndexerProvider,

    // Script-related
    ArkAddress,
    DefaultVtxo,
    VtxoScript,
    VHTLC,

    // Enums
    TxType,
    IndexerTxType,
    ChainTxType,
    SettlementEventType,

    // Service Worker
    setupServiceWorker,
    Worker,
    ServiceWorkerWallet,
    Request,
    Response,

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

    // Repositories
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
};
