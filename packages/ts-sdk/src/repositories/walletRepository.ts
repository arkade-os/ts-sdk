import { ArkTransaction, ExtendedCoin, ExtendedVirtualCoin } from "../wallet";
import type { TxKey } from "../wallet";
import type { PageRequest, PageResult } from "./page";

export interface TransactionHistoryPageFilter {
    address: string;
    /** Inclusive milliseconds since epoch. */
    since?: number;
}

export interface TransactionHistoryPageCursor {
    createdAt: number;
    key: TxKey;
}

export function compareTxKeys(a: TxKey, b: TxKey): number {
    for (const field of ["boardingTxid", "commitmentTxid", "arkTxid"] as const) {
        if (a[field] < b[field]) return -1;
        if (a[field] > b[field]) return 1;
    }
    return 0;
}

export function compareHistoryCursors(
    a: TransactionHistoryPageCursor,
    b: TransactionHistoryPageCursor,
): number {
    return a.createdAt - b.createdAt || compareTxKeys(a.key, b.key);
}

export function assertHistoryPageFilter(filter: TransactionHistoryPageFilter): void {
    if (filter.since !== undefined && (!Number.isSafeInteger(filter.since) || filter.since < 0)) {
        throw new RangeError("history since must be non-negative Unix milliseconds");
    }
}

export interface WalletState {
    /** Arbitrary stored wallet settings. */
    settings?: Record<string, any>;

    /**
     * High-water mark for VTXO indexer syncs, in milliseconds.
     *
     * Reused the legacy `lastSyncTime` column name to avoid an
     * `ALTER TABLE` migration; the value is interpreted as the new
     * "max indexer `updatedAt`" cursor only after `settings.vtxoCursorMigrated`
     * is set, so pre-existing values written by the buggy pre-PR sync
     * are ignored and force a one-shot re-bootstrap on upgrade.
     */
    lastSyncTime?: number;
}

/** Stored commitment transaction metadata. */
export type CommitmentTxRecord = {
    /** Commitment transaction id. */
    txid: string;

    /** Creation timestamp in milliseconds. */
    createdAt: number;
};

export interface VtxoRepositoryKey {
    /** Authoritative ownership key. */
    script: string;
    /** Legacy storage bucket. Required by all current backends; throw if absent. */
    address?: string;
}

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

    /**
     * Fetch stored virtual outputs for a script.
     * @optional SDK backends implement this; custom backends fall back to Tier 1.
     */
    getVtxosForScript?(script: string): Promise<ExtendedVirtualCoin[]>;

    /**
     * Save virtual outputs for a script.
     * @optional SDK backends implement this; custom backends fall back to Tier 1.
     */
    saveVtxosForScript?(key: VtxoRepositoryKey, vtxos: ExtendedVirtualCoin[]): Promise<void>;

    /**
     * Delete stored virtual outputs for a script.
     * @optional SDK backends implement this; custom backends fall back to Tier 1.
     */
    deleteVtxosForScript?(script: string): Promise<void>;

    /** Fetch stored boarding inputs for an address. */
    getUtxos(address: string): Promise<ExtendedCoin[]>;
    /** Save boarding inputs for an address. */
    saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void>;
    /** Delete stored boarding inputs for an address. */
    deleteUtxos(address: string): Promise<void>;

    /** Fetch stored transaction history for an address. */
    getTransactionHistory(address: string): Promise<ArkTransaction[]>;
    /** History in ascending creation time and transaction-key order; `after` is exclusive. */
    getTransactionHistoryPage(
        filter: TransactionHistoryPageFilter,
        page: PageRequest<TransactionHistoryPageCursor>,
    ): Promise<PageResult<ArkTransaction, TransactionHistoryPageCursor>>;
    /** Save transaction history for an address. */
    saveTransactions(address: string, txs: ArkTransaction[]): Promise<void>;
    /** Delete stored transaction history for an address. */
    deleteTransactions(address: string): Promise<void>;

    /** Fetch stored wallet state. */
    getWalletState(): Promise<WalletState | null>;
    /** Save wallet state. */
    saveWalletState(state: WalletState): Promise<void>;
}
