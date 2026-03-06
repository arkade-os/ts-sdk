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
    readonly version: 1;

    /**
     * Clear all data from storage.
     */
    clear(): Promise<void>;

    // VTXO management
    getVtxos(address: string): Promise<ExtendedVirtualCoin[]>;
    saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    deleteVtxos(address: string): Promise<void>;

    // UTXO management
    getUtxos(address: string): Promise<ExtendedCoin[]>;
    saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void>;
    deleteUtxos(address: string): Promise<void>;

    // Transaction history
    getTransactionHistory(address: string): Promise<ArkTransaction[]>;
    saveTransactions(address: string, txs: ArkTransaction[]): Promise<void>;
    deleteTransactions(address: string): Promise<void>;

    // Wallet state
    getWalletState(): Promise<WalletState | null>;
    saveWalletState(state: WalletState): Promise<void>;
}
