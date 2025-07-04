import { InMemoryKey } from "./identity/inMemoryKey";
import { Identity } from "./identity";
import { ArkAddress } from "./script/address";
import { VHTLC } from "./script/vhtlc";
import { DefaultVtxo } from "./script/default";
import { VtxoScript } from "./script/base";
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
    VtxoTaprootAddress,
    AddressInfo,
    TapscriptInfo,
    Status,
    VirtualStatus,
    Outpoint,
    VirtualCoin,
    TxKey,
    Addresses,
} from "./wallet/index";
import { Wallet } from "./wallet/wallet";
import { ServiceWorkerWallet } from "./wallet/serviceWorker/wallet";
import { setupServiceWorker } from "./wallet/serviceWorker/utils";
import { Worker } from "./wallet/serviceWorker/worker";
import { Request } from "./wallet/serviceWorker/request";
import { Response } from "./wallet/serviceWorker/response";
import { ESPLORA_URL, EsploraProvider } from "./providers/onchain";
import { RestArkProvider } from "./providers/ark";
import {
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    CSVMultisigTapscript,
    decodeTapscript,
    MultisigTapscript,
    TapscriptType,
} from "./script/tapscript";
import {
    addConditionWitness,
    CONDITION_WITNESS_KEY_PREFIX,
    createVirtualTx,
} from "./utils/psbt";
import { ArkNote, ArkNoteData } from "./arknote";
import { IndexedDBVtxoRepository } from "./wallet/serviceWorker/db/vtxo/idb";
import { VtxoRepository } from "./wallet/serviceWorker/db/vtxo";
import { networks } from "./networks";

export {
    Wallet,
    InMemoryKey,

    // Providers
    ESPLORA_URL,
    EsploraProvider,
    RestArkProvider,

    // Script-related
    ArkAddress,
    DefaultVtxo,
    VtxoScript,
    VHTLC,

    // Enums
    TxType,

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

    // Utils
    addConditionWitness,
    CONDITION_WITNESS_KEY_PREFIX,
    createVirtualTx,

    // Arknote
    ArkNote,
    ArkNoteData,

    // Network
    networks,

    // Database
    IndexedDBVtxoRepository,
};

// Type exports
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
    VtxoTaprootAddress,
    AddressInfo,
    Addresses,
    TapscriptInfo,
    Status,
    VirtualStatus,
    Outpoint,
    VirtualCoin,
    TxKey,
    TapscriptType,
    VtxoRepository,
};
