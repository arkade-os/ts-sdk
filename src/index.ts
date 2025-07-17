import { Transaction } from "@scure/btc-signer";
import { SingleKey } from "./identity/singleKey";
import { Identity } from "./identity";
import { ArkAddress } from "./script/address";
import { VHTLC } from "./script/vhtlc";
import { DefaultVtxo } from "./script/default";
import { VtxoScript, EncodedVtxoScript, TapLeafScript } from "./script/base";
import {
    TxType,
    IWallet,
    WalletConfig,
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
} from "./wallet";
import { Wallet, waitForIncomingFunds, IncomingFunds } from "./wallet/wallet";
import { TxTree, TxTreeNode } from "./tree/txTree";
import {
    SignerSession,
    TreeNonces,
    TreePartialSigs,
} from "./tree/signingSession";
import { Ramps } from "./wallet/ramps";
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
    Intent,
    Output,
    TxNotification,
    BatchFinalizationEvent,
    BatchFinalizedEvent,
    BatchFailedEvent,
    TreeSigningStartedEvent,
    TreeNoncesAggregatedEvent,
    BatchStartedEvent,
    TreeTxEvent,
    TreeSignatureEvent,
    MarketHour,
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
    buildOffchainTx,
    ArkTxInput,
    OffchainTx,
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
import { BIP322 } from "./bip322";
import { ArkNote } from "./arknote";
import { IndexedDBVtxoRepository } from "./wallet/serviceWorker/db/vtxo/idb";
import { VtxoRepository } from "./wallet/serviceWorker/db/vtxo";
import { networks, Network, NetworkName } from "./networks";
import {
    RestIndexerProvider,
    IndexerProvider,
    IndexerTxType,
    ChainTxType,
    PageResponse,
    Batch,
    ChainTx,
    CommitmentTx,
    TxHistoryRecord,
    VtxoChain,
    Tx,
    Vtxo,
    PaginationOptions,
    SubscriptionResponse,
} from "./providers/indexer";
import { Nonces } from "./musig2/nonces";
import { PartialSig } from "./musig2/sign";
import { AnchorBumper, P2A } from "./utils/anchor";
import { Unroll } from "./wallet/unroll";

export {
    // Wallets
    Wallet,
    SingleKey,
    OnchainWallet,
    Ramps,

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
    waitForIncomingFunds,

    // Arknote
    ArkNote,

    // Network
    networks,

    // Database
    IndexedDBVtxoRepository,

    // BIP322
    BIP322,

    // TxTree
    TxTree,

    // Anchor
    P2A,
    Unroll,
    Transaction,
};

export type {
    // Types and Interfaces
    Identity,
    IWallet,
    WalletConfig,
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
    VtxoRepository,
    ArkTxInput,
    OffchainTx,
    TapLeaves,
    IncomingFunds,

    // Indexer types
    IndexerProvider,
    PageResponse,
    Batch,
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
    ArkInfo,
    Intent,
    Output,
    TxNotification,
    ExplorerTransaction,
    BatchFinalizationEvent,
    BatchFinalizedEvent,
    BatchFailedEvent,
    TreeSigningStartedEvent,
    TreeNoncesAggregatedEvent,
    BatchStartedEvent,
    TreeTxEvent,
    TreeSignatureEvent,
    MarketHour,
    PaginationOptions,
    SubscriptionResponse,

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
