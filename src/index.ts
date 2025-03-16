import { InMemoryKey } from "./core/identity";
import { ArkAddress } from "./core/address";
import { VtxoTapscript } from "./core/tapscript";
import { BareWallet, Wallet, WalletConfig } from "./core/wallet";
import { ServiceWorkerWallet } from "./core/sw_wallet";
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
    Wallet,
    SettlementEvent,
    SettlementEventType,
    OnchainProvider,
    ArkProvider,
};
export {
    BareWallet,
    ServiceWorkerWallet,
    InMemoryKey,
    ESPLORA_URL,
    EsploraProvider,
    RestArkProvider,
    ArkAddress,
    VtxoTapscript,
};
