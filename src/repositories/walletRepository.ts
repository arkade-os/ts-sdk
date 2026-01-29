import { ArkTransaction, ExtendedCoin, ExtendedVirtualCoin } from "../wallet";

export interface WalletState {
    lastSyncTime?: number;
    settings?: Record<string, any>;
}

export type CommitmentTxRecord = {
    txid: string;
    createdAt: number;
};

export interface WalletRepository extends AsyncDisposable {
    // VTXO management
    getVtxos(address: string): Promise<ExtendedVirtualCoin[]>;
    saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    clearVtxos(address: string): Promise<void>;

    // UTXO management
    getUtxos(address: string): Promise<ExtendedCoin[]>;
    saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void>;
    clearUtxos(address: string): Promise<void>;

    // Transaction history
    getTransactionHistory(address: string): Promise<ArkTransaction[]>;
    saveTransactions(address: string, txs: ArkTransaction[]): Promise<void>;
    clearTransactions(address: string): Promise<void>;

    // Wallet state
    getWalletState(): Promise<WalletState | null>;
    saveWalletState(state: WalletState): Promise<void>;
}
