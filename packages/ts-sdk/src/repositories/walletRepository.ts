import { ArkTransaction, ExtendedCoin, ExtendedVirtualCoin } from "../wallet";

export interface WalletState {
    /** Timestamp of the last successful wallet sync, in milliseconds. */
    lastSyncTime?: number;

    /** Arbitrary stored wallet settings. */
    settings?: Record<string, any>;
}

/** Stored commitment transaction metadata. */
export type CommitmentTxRecord = {
    /** Commitment transaction id. */
    txid: string;

    /** Creation timestamp in milliseconds. */
    createdAt: number;
};

export interface WalletRepository extends AsyncDisposable {
    readonly version: 1;

    /**
     * Clear all data from storage.
     */
    clear(): Promise<void>;

    /** Fetch stored virtual outputs for an address. */
    getVtxos(address: string): Promise<ExtendedVirtualCoin[]>;
    /** Save virtual outputs for an address. */
    saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    /** Delete stored virtual outputs for an address. */
    deleteVtxos(address: string): Promise<void>;

    /** Fetch stored boarding inputs for an address. */
    getUtxos(address: string): Promise<ExtendedCoin[]>;
    /** Save boarding inputs for an address. */
    saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void>;
    /** Delete stored boarding inputs for an address. */
    deleteUtxos(address: string): Promise<void>;

    /** Fetch stored transaction history for an address. */
    getTransactionHistory(address: string): Promise<ArkTransaction[]>;
    /** Save transaction history for an address. */
    saveTransactions(address: string, txs: ArkTransaction[]): Promise<void>;
    /** Delete stored transaction history for an address. */
    deleteTransactions(address: string): Promise<void>;

    /** Fetch stored wallet state. */
    getWalletState(): Promise<WalletState | null>;
    /** Save wallet state. */
    saveWalletState(state: WalletState): Promise<void>;
}
