import { InMemoryKey } from "./core/identity/inMemoryKey";
import { Identity } from "./core/identity";
import { ArkAddress } from "./core/address";
import { VtxoTapscript } from "./core/tapscript";
import { IWallet, WalletConfig, ArkTransaction, TxType } from "./core/wallet";
import { Wallet } from "./core/wallet/wallet";
import { ServiceWorkerWallet } from "./core/wallet/serviceWorkerWallet";
import {
    ESPLORA_URL,
    EsploraProvider,
    OnchainProvider,
} from "./providers/onchain";
import {
    SettlementEvent,
    SettlementEventType,
    RestArkProvider,
    ArkProvider,
} from "./providers/ark";

export type {
    WalletConfig,
    IWallet,
    SettlementEvent,
    SettlementEventType,
    OnchainProvider,
    ArkProvider,
    Identity,
    ArkTransaction,
};
export {
    Wallet,
    ServiceWorkerWallet,
    InMemoryKey,
    ESPLORA_URL,
    EsploraProvider,
    RestArkProvider,
    ArkAddress,
    VtxoTapscript,
    TxType,
};
