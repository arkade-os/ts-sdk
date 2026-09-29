import { ArkTransaction, ExtendedCoin, ExtendedVirtualCoin } from "../../wallet";
import type { Outpoint } from "../../wallet";
import {
    WalletRepository,
    WalletState,
    VtxoRepositoryKey,
    assertHistoryPageFilter,
    compareHistoryCursors,
    compareOutpoints,
    compareScriptVtxoCursors,
    type TransactionHistoryPageFilter,
    type TransactionHistoryPageCursor,
    type ScriptVtxoCursor,
    type StoredVtxo,
} from "../walletRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";
import { isVtxoForScript } from "../../contracts/vtxoOwnership";

/**
 * In-memory implementation of WalletRepository.
 * Data is ephemeral and scoped to the instance.
 */
export class InMemoryWalletRepository implements WalletRepository {
    readonly version = 1 as const;
    private readonly vtxosByAddress = new Map<string, ExtendedVirtualCoin[]>();
    private readonly utxosByAddress = new Map<string, ExtendedCoin[]>();
    private readonly txsByAddress = new Map<string, ArkTransaction[]>();

    private walletState: WalletState | null = null;

    async getVtxosPage(
        address: string,
        page: PageRequest<Outpoint>,
    ): Promise<PageResult<ExtendedVirtualCoin, Outpoint>> {
        return pageOutpoints(this.vtxosByAddress.get(address) ?? [], page);
    }

    async saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void> {
        const existing = this.vtxosByAddress.get(address) ?? [];
        const next = mergeByKey(existing, vtxos, (item) => `${item.txid}:${item.vout}`);
        this.vtxosByAddress.set(address, next);
    }

    async deleteVtxos(address: string): Promise<void> {
        this.vtxosByAddress.delete(address);
    }

    async getVtxosForScriptPage(
        script: string,
        page: PageRequest<ScriptVtxoCursor>,
    ): Promise<PageResult<StoredVtxo, ScriptVtxoCursor>> {
        assertPageRequest(page);
        const allMatches: StoredVtxo[] = [];
        for (const [address, bucket] of this.vtxosByAddress) {
            for (const vtxo of bucket) {
                if (isVtxoForScript(vtxo, script)) {
                    allMatches.push({ address, vtxo });
                }
            }
        }
        const cursorOf = (row: StoredVtxo): ScriptVtxoCursor => ({
            address: row.address,
            txid: row.vtxo.txid,
            vout: row.vtxo.vout,
        });
        const rows = allMatches
            .filter(
                (row) =>
                    page.after === undefined ||
                    compareScriptVtxoCursors(cursorOf(row), page.after) > 0,
            )
            .sort((a, b) => compareScriptVtxoCursors(cursorOf(a), cursorOf(b)))
            .slice(0, page.limit + 1);
        return pageResult(rows, page.limit, cursorOf);
    }

    async saveVtxosForScript(key: VtxoRepositoryKey, vtxos: ExtendedVirtualCoin[]): Promise<void> {
        if (!key.address) {
            throw new Error("InMemoryWalletRepository requires an address");
        }
        for (const vtxo of vtxos) {
            if (!isVtxoForScript(vtxo, key.script)) {
                throw new Error(
                    `VTXO ${vtxo.txid}:${vtxo.vout} script mismatch: expected ${key.script}, got ${vtxo.script}`,
                );
            }
        }
        return this.saveVtxos(key.address, vtxos);
    }

    async deleteVtxosForScript(script: string): Promise<void> {
        for (const [address, bucket] of this.vtxosByAddress.entries()) {
            const next = bucket.filter((v) => !isVtxoForScript(v, script));
            if (next.length === 0) {
                this.vtxosByAddress.delete(address);
            } else {
                this.vtxosByAddress.set(address, next);
            }
        }
    }

    async getUtxosPage(
        address: string,
        page: PageRequest<Outpoint>,
    ): Promise<PageResult<ExtendedCoin, Outpoint>> {
        return pageOutpoints(this.utxosByAddress.get(address) ?? [], page);
    }

    async saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void> {
        const existing = this.utxosByAddress.get(address) ?? [];
        const next = mergeByKey(existing, utxos, (item) => `${item.txid}:${item.vout}`);
        this.utxosByAddress.set(address, next);
    }

    async deleteUtxos(address: string): Promise<void> {
        this.utxosByAddress.delete(address);
    }

    async getTransactionHistoryPage(
        filter: TransactionHistoryPageFilter,
        page: PageRequest<TransactionHistoryPageCursor>,
    ): Promise<PageResult<ArkTransaction, TransactionHistoryPageCursor>> {
        assertPageRequest(page);
        assertHistoryPageFilter(filter);
        const rows = (this.txsByAddress.get(filter.address) ?? [])
            .filter(
                (tx) =>
                    (filter.since === undefined || tx.createdAt >= filter.since) &&
                    (page.after === undefined ||
                        compareHistoryCursors(
                            { createdAt: tx.createdAt, key: tx.key },
                            page.after,
                        ) > 0),
            )
            .sort((a, b) =>
                compareHistoryCursors(
                    { createdAt: a.createdAt, key: a.key },
                    { createdAt: b.createdAt, key: b.key },
                ),
            )
            .slice(0, page.limit + 1);
        return pageResult(rows, page.limit, (tx) => ({ createdAt: tx.createdAt, key: tx.key }));
    }

    async saveTransactions(address: string, txs: ArkTransaction[]): Promise<void> {
        const existing = this.txsByAddress.get(address) ?? [];
        const next = mergeByKey(existing, txs, serializeTxKey);
        this.txsByAddress.set(address, next);
    }

    async deleteTransactions(address: string): Promise<void> {
        this.txsByAddress.delete(address);
    }

    async getWalletState(): Promise<WalletState | null> {
        return this.walletState;
    }

    async saveWalletState(state: WalletState): Promise<void> {
        this.walletState = state;
    }

    async clear(): Promise<void> {
        this.vtxosByAddress.clear();
        this.utxosByAddress.clear();
        this.txsByAddress.clear();
        this.walletState = null;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // nothing to dispose, data is ephemeral and scoped to the instance
        return;
    }
}

function serializeTxKey(tx: ArkTransaction): string {
    const key = tx.key;
    return `${key.boardingTxid}:${key.commitmentTxid}:${key.arkTxid}`;
}

function pageOutpoints<Item extends Outpoint>(
    rows: Item[],
    page: PageRequest<Outpoint>,
): PageResult<Item, Outpoint> {
    assertPageRequest(page);
    const selected = rows
        .filter((row) => page.after === undefined || compareOutpoints(row, page.after) > 0)
        .sort(compareOutpoints)
        .slice(0, page.limit + 1);
    return pageResult(selected, page.limit, ({ txid, vout }) => ({ txid, vout }));
}

function mergeByKey<T>(existing: T[], incoming: T[], toKey: (item: T) => string): T[] {
    const next = new Map<string, T>();
    existing.forEach((item) => {
        next.set(toKey(item), item);
    });
    incoming.forEach((item) => {
        next.set(toKey(item), item);
    });
    return Array.from(next.values());
}
