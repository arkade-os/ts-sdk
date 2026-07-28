import type { Wallet, NetworkName } from "@arkade-os/sdk";
import type { SatsConnectNetwork } from "@arkade-os/sats-connect";

export type { SatsConnectNetwork };

export interface NetworkConfig {
    networkName: NetworkName;
    arkServerUrl: string;
    esploraUrl: string;
    boltzUrl?: string;
    hasLightning: boolean;
    satsConnectNetwork: SatsConnectNetwork;
}

export interface WalletInfo {
    arkAddress: string;
    boardingAddress: string;
    paymentAddress: string;
    ordinalsAddress?: string;
    network: string;
    userPubKey?: string;
}

export interface Balance {
    total: number;
    onchain: number;
    offchain: number;
    settled: number;
    preconfirmed: number;
    recoverable: number;
    vtxoList: Array<{
        id: string;
        amount: number;
        expiry: number;
        status: string;
    }>;
}

export interface Transaction {
    txid: string;
    amount: number;
    type: "send" | "receive";
    timestamp: number;
    layer: "onchain" | "offchain";
    status?: string;
}

export interface ArkadeWalletProviderConfig<TNetwork extends string = string> {
    networks: Record<TNetwork, NetworkConfig>;
    defaultNetwork: TNetwork;
    autoConnectKey?: string;
    connectMessage?: string;
}

export interface ArkadeWalletContextType<TNetwork extends string = string> {
    wallet: Wallet | null;
    walletInfo: WalletInfo | null;
    balance: Balance | null;
    transactions: Transaction[];
    isConnecting: boolean;
    isLoading: boolean;
    error: string | null;
    connectWallet: (options?: { silent?: boolean }) => Promise<void>;
    disconnectWallet: () => void;
    getBalance: (options?: { silent?: boolean }) => Promise<void>;
    sendBitcoin: (toAddress: string, amount: number) => Promise<string>;
    getTransactionHistory: () => Promise<void>;
    payLightningInvoice: (invoice: string) => Promise<string>;
    createLightningInvoice: (amount: number, description?: string) => Promise<string>;
    onboardFunds: () => Promise<string>;
    switchNetwork: (network: TNetwork) => Promise<void>;
    currentNetwork: TNetwork;
    currentNetworkConfig: NetworkConfig;
}
