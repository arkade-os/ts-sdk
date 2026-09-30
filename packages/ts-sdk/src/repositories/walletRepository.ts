import { ArkTransaction, ExtendedCoin, ExtendedVirtualCoin, type Outpoint } from "../wallet";
import type { TxKey } from "../wallet";
import {
    assertCursorAdvanced,
    collectPages,
    MAX_COLLECT_PAGES,
    MAX_PAGE_SIZE,
    type PageRequest,
    type PageResult,
} from "./page";
import { scriptFromArkAddress } from "./scriptFromAddress";
import { isVtxoSpent } from "../wallet/vtxo";

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

export function compareOutpoints(a: Outpoint, b: Outpoint): number {
    return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout;
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

export interface ScriptVtxoCursor extends Outpoint {
    address: string;
}

export interface StoredVtxo {
    address: string;
    vtxo: ExtendedVirtualCoin;
}

export function compareScriptVtxoCursors(a: ScriptVtxoCursor, b: ScriptVtxoCursor): number {
    return a.address < b.address ? -1 : a.address > b.address ? 1 : compareOutpoints(a, b);
}

/** `unspentOnly` omits spent outputs. A page may then hold fewer than `limit`
 * items and still carry `nextCursor`. */
export interface ScriptVtxoPageOptions {
    unspentOnly?: boolean;
}

export interface WalletRepository extends AsyncDisposable {
    readonly version: 1;

    /**
     * Clear all data from storage.
     */
    clear(): Promise<void>;

    getVtxosPage(
        address: string,
        page: PageRequest<Outpoint>,
    ): Promise<PageResult<ExtendedVirtualCoin, Outpoint>>;
    /** Save virtual outputs for an address. */
    saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    /** Delete stored virtual outputs for an address. */
    deleteVtxos(address: string): Promise<void>;

    /**
     * Fetch stored virtual outputs for a script.
     * An outpoint may appear more than once across address buckets, including
     * within one page. Deduplicate by outpoint or use collectScriptVtxos.
     * @optional SDK backends implement this; custom backends fall back to Tier 1.
     */
    getVtxosForScriptPage?(
        script: string,
        page: PageRequest<ScriptVtxoCursor>,
        options?: ScriptVtxoPageOptions,
    ): Promise<PageResult<StoredVtxo, ScriptVtxoCursor>>;

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

    getUtxosPage(
        address: string,
        page: PageRequest<Outpoint>,
    ): Promise<PageResult<ExtendedCoin, Outpoint>>;
    /** Save boarding inputs for an address. */
    saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void>;
    /** Delete stored boarding inputs for an address. */
    deleteUtxos(address: string): Promise<void>;

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

export const collectVtxos = (repository: Pick<WalletRepository, "getVtxosPage">, address: string) =>
    collectPages((page: PageRequest<Outpoint>) => repository.getVtxosPage(address, page));

export const collectUtxos = (repository: Pick<WalletRepository, "getUtxosPage">, address: string) =>
    collectPages((page: PageRequest<Outpoint>) => repository.getUtxosPage(address, page));

export const collectTransactionHistory = (
    repository: Pick<WalletRepository, "getTransactionHistoryPage">,
    address: string,
) =>
    collectPages((page: PageRequest<TransactionHistoryPageCursor>) =>
        repository.getTransactionHistoryPage({ address }, page),
    );

export async function collectScriptVtxos(
    repository: WalletRepository,
    script: string,
    options?: ScriptVtxoPageOptions,
): Promise<ExtendedVirtualCoin[]> {
    if (!repository.getVtxosForScriptPage) {
        throw new Error(
            "script VTXO paging is unavailable; use collectVtxos with a known address and filter by script",
        );
    }
    const byOutpoint = new Map<string, StoredVtxo>();
    let after: ScriptVtxoCursor | undefined;
    let pages = 0;
    do {
        if (++pages > MAX_COLLECT_PAGES) {
            throw new Error("collectScriptVtxos: page limit exceeded");
        }
        const page = await repository.getVtxosForScriptPage(
            script,
            { limit: MAX_PAGE_SIZE, after },
            options,
        );
        assertCursorAdvanced(after, page.nextCursor);
        for (const row of page.items) {
            const key = `${row.vtxo.txid}:${row.vtxo.vout}`;
            const previous = byOutpoint.get(key);
            if (!previous || shouldReplaceScriptVtxo(previous, row)) byOutpoint.set(key, row);
        }
        after = page.nextCursor;
    } while (after !== undefined);
    return [...byOutpoint.values()].map((row) => row.vtxo);
}

/** Unspent `rows` that no spent copy of the same outpoint in `copies` outranks, so
 * collecting them matches collecting everything and dropping spent winners. */
export function unspentScriptVtxos(rows: StoredVtxo[], copies: StoredVtxo[]): StoredVtxo[] {
    const spent = copies.filter((copy) => isVtxoSpent(copy.vtxo));
    return rows.filter(
        (row) =>
            !isVtxoSpent(row.vtxo) &&
            !spent.some(
                (copy) =>
                    copy.address !== row.address &&
                    copy.vtxo.txid === row.vtxo.txid &&
                    copy.vtxo.vout === row.vtxo.vout &&
                    shouldReplaceScriptVtxo(row, copy),
            ),
    );
}

function shouldReplaceScriptVtxo(existing: StoredVtxo, incoming: StoredVtxo): boolean {
    const canonical = (row: StoredVtxo) => {
        try {
            return scriptFromArkAddress(row.address) === row.vtxo.script;
        } catch {
            return false;
        }
    };
    if (canonical(incoming) !== canonical(existing)) return canonical(incoming);
    // A recorded spend wins over an unspent duplicate of the same outpoint.
    if (
        existing.vtxo.isSpent !== incoming.vtxo.isSpent &&
        (existing.vtxo.isSpent === true || incoming.vtxo.isSpent === true)
    ) {
        return incoming.vtxo.isSpent === true;
    }
    const weight = (row: StoredVtxo) =>
        Number(row.vtxo.isSpent !== undefined) +
        2 * Number(!!row.vtxo.spentBy) +
        2 * Number(!!row.vtxo.settledBy) +
        2 * Number(!!row.vtxo.arkTxId);
    return (
        weight(incoming) > weight(existing) ||
        (weight(incoming) === weight(existing) && incoming.address < existing.address)
    );
}
