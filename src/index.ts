import { InMemoryKey } from "./identity/inMemoryKey";
import { Identity } from "./identity";
import { ArkAddress } from "./address";
import { VtxoTapscript } from "./tapscript";
import { IWallet, WalletConfig, ArkTransaction, TxType } from "./wallet";
import { Wallet } from "./wallet/wallet";
import { ServiceWorkerWallet } from "./wallet/serviceWorker/wallet";
import { Worker } from "./wallet/serviceWorker/worker";
import { Request } from "./wallet/serviceWorker/request";
import { Response } from "./wallet/serviceWorker/response";
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
    Worker,
    Request,
    Response,
};
