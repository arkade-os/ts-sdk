import { ExtendedCoin, ExtendedVirtualCoin, ArkTransaction } from "../../wallet";
import type { Outpoint } from "../../wallet";
import {
    WalletRepository,
    WalletState,
    VtxoRepositoryKey,
    assertHistoryPageFilter,
    compareHistoryCursors,
    type TransactionHistoryPageFilter,
    type TransactionHistoryPageCursor,
    type ScriptVtxoCursor,
    type ScriptVtxoPageOptions,
    type StoredVtxo,
    compareScriptVtxoCursors,
    unspentScriptVtxos,
} from "../walletRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";
import {
    STORE_VTXOS,
    STORE_UTXOS,
    STORE_TRANSACTIONS,
    STORE_WALLET_STATE,
    serializeVtxo,
    serializeUtxo,
    deserializeVtxo,
    deserializeUtxo,
    SerializedVtxo,
    DB_VERSION,
} from "./db";
import { awaitTransaction, deleteByIndex, getAllByIndexValues, promisifyRequest } from "./idbUtils";
import { createManagedConnection, ManagedConnection } from "./managedConnection";
import { initDatabase, unspentFlag } from "./schema";
import { scriptFromArkAddress } from "../scriptFromAddress";
import { legacyFactsOfRow } from "../legacyVtxoFacts";
import { DEFAULT_DB_NAME } from "../../worker/browser/utils";
import { isVtxoForScript } from "../../contracts/vtxoOwnership";

/**
 * IndexedDB-based implementation of WalletRepository.
 */
export class IndexedDBWalletRepository implements WalletRepository {
    readonly version = 1 as const;
    private readonly connection: ManagedConnection;

    constructor(dbName: string = DEFAULT_DB_NAME) {
        this.connection = createManagedConnection(dbName, DB_VERSION, initDatabase);
    }

    async clear(): Promise<void> {
        try {
            const db = await this.getDB();
            const stores = [STORE_VTXOS, STORE_UTXOS, STORE_TRANSACTIONS, STORE_WALLET_STATE];
            const transaction = db.transaction(stores, "readwrite");
            for (const name of stores) transaction.objectStore(name).clear();
            await awaitTransaction(transaction);
        } catch (error) {
            console.error("Failed to clear wallet data:", error);
            throw error;
        }
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.connection[Symbol.asyncDispose]();
    }

    async getVtxosPage(
        address: string,
        page: PageRequest<Outpoint>,
    ): Promise<PageResult<ExtendedVirtualCoin, Outpoint>> {
        return this.pageByAddress(STORE_VTXOS, address, page, deserializeVtxoWithBackfill);
    }

    async saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_VTXOS], "readwrite");
            const store = transaction.objectStore(STORE_VTXOS);
            for (const vtxo of vtxos) {
                const serialized: SerializedVtxo = serializeVtxo(vtxo);
                store.put({ address, ...serialized, ...unspentFlag(vtxo) });
            }
            await awaitTransaction(transaction);
        } catch (error) {
            console.error(`Failed to save VTXOs for address ${address}:`, error);
            throw error;
        }
    }

    async deleteVtxos(address: string): Promise<void> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_VTXOS], "readwrite");
            deleteByIndex(transaction.objectStore(STORE_VTXOS), "address", address);
            await awaitTransaction(transaction);
        } catch (error) {
            console.error(`Failed to clear VTXOs for address ${address}:`, error);
            throw error;
        }
    }

    async getVtxosForScriptPage(
        script: string,
        page: PageRequest<ScriptVtxoCursor>,
        options?: ScriptVtxoPageOptions,
    ): Promise<PageResult<StoredVtxo, ScriptVtxoCursor>> {
        assertPageRequest(page);
        const db = await this.getDB();
        const store = db.transaction([STORE_VTXOS], "readonly").objectStore(STORE_VTXOS);
        // Unspent rows carry `unspent: 1`, so this index never touches spent history.
        const indexKey: IDBValidKey = options?.unspentOnly ? [script, 1] : script;
        const index = store.index(options?.unspentOnly ? "scriptUnspent" : "script");
        return new Promise((resolve, reject) => {
            // Called from a request callback, so the duplicate recheck reuses this transaction.
            const finish = (rows: RawVtxoRow[]) => {
                const result = pageResult(rows.map(storedVtxoOf), page.limit, scriptVtxoCursorOf);
                if (!options?.unspentOnly || result.items.length === 0) return resolve(result);
                // A newer spent copy in another address bucket is absent from `scriptUnspent`.
                const txids = [...new Set(result.items.map((row) => row.vtxo.txid))];
                getAllByIndexValues<RawVtxoRow>(store, "txid", txids).then((raws) => {
                    const copies = raws
                        .map(storedVtxoOf)
                        .filter((copy) => copy.vtxo.script === script);
                    resolve({ ...result, items: unspentScriptVtxos(result.items, copies) });
                }, reject);
            };
            const after = page.after;
            if (!after) {
                const request = index.getAll(IDBKeyRange.only(indexKey), page.limit + 1);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    try {
                        finish(request.result as RawVtxoRow[]);
                    } catch (error) {
                        reject(error);
                    }
                };
                return;
            }
            const rows: RawVtxoRow[] = [];
            const request = index.openCursor(IDBKeyRange.only(indexKey));
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                try {
                    const cursor = request.result;
                    if (!cursor) return finish(rows);
                    const row = cursor.value as RawVtxoRow;
                    const order = compareScriptVtxoCursors(
                        { address: row.address, txid: row.txid, vout: row.vout },
                        after,
                    );
                    if (order < 0) {
                        cursor.continuePrimaryKey(indexKey, [
                            after.address,
                            after.txid,
                            after.vout,
                        ]);
                        return;
                    }
                    if (order > 0) rows.push(row);
                    if (rows.length > page.limit) return finish(rows);
                    cursor.continue();
                } catch (error) {
                    reject(error);
                }
            };
        });
    }

    async saveVtxosForScript(key: VtxoRepositoryKey, vtxos: ExtendedVirtualCoin[]): Promise<void> {
        if (!key.address) {
            throw new Error("IndexedDBWalletRepository requires an address");
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
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_VTXOS], "readwrite");
            deleteByIndex(transaction.objectStore(STORE_VTXOS), "script", script);
            await awaitTransaction(transaction);
        } catch (error) {
            console.error(`Failed to clear VTXOs for script ${script}:`, error);
            throw error;
        }
    }

    async getUtxosPage(
        address: string,
        page: PageRequest<Outpoint>,
    ): Promise<PageResult<ExtendedCoin, Outpoint>> {
        return this.pageByAddress(STORE_UTXOS, address, page, deserializeUtxo);
    }

    private async pageByAddress<Item>(
        name: string,
        address: string,
        page: PageRequest<Outpoint>,
        deserialize: (row: any) => Item,
    ): Promise<PageResult<Item, Outpoint>> {
        assertPageRequest(page);
        const db = await this.getDB();
        const store = db.transaction([name], "readonly").objectStore(name);
        const key = page.after ? [address, page.after.txid, page.after.vout] : [address];
        const request = store.openCursor(IDBKeyRange.lowerBound(key, page.after !== undefined));
        return new Promise((resolve, reject) => {
            const rows: { key: Outpoint; item: Item }[] = [];
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                try {
                    const cursor = request.result;
                    if (!cursor || (cursor.key as unknown[])[0] !== address) {
                        const result = pageResult(rows, page.limit, (row) => row.key);
                        resolve({
                            items: result.items.map((row) => row.item),
                            nextCursor: result.nextCursor,
                        });
                        return;
                    }
                    const [, txid, vout] = cursor.key as [string, string, number];
                    rows.push({ key: { txid, vout }, item: deserialize(cursor.value) });
                    if (rows.length > page.limit) {
                        const result = pageResult(rows, page.limit, (row) => row.key);
                        resolve({
                            items: result.items.map((row) => row.item),
                            nextCursor: result.nextCursor,
                        });
                        return;
                    }
                    cursor.continue();
                } catch (error) {
                    reject(error);
                }
            };
        });
    }

    async saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_UTXOS], "readwrite");
            const store = transaction.objectStore(STORE_UTXOS);
            for (const utxo of utxos) store.put({ address, ...serializeUtxo(utxo) });
            await awaitTransaction(transaction);
        } catch (error) {
            console.error(`Failed to save UTXOs for address ${address}:`, error);
            throw error;
        }
    }

    async deleteUtxos(address: string): Promise<void> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_UTXOS], "readwrite");
            deleteByIndex(transaction.objectStore(STORE_UTXOS), "address", address);
            await awaitTransaction(transaction);
        } catch (error) {
            console.error(`Failed to clear UTXOs for address ${address}:`, error);
            throw error;
        }
    }

    async getTransactionHistoryPage(
        filter: TransactionHistoryPageFilter,
        page: PageRequest<TransactionHistoryPageCursor>,
    ): Promise<PageResult<ArkTransaction, TransactionHistoryPageCursor>> {
        assertPageRequest(page);
        assertHistoryPageFilter(filter);
        const db = await this.getDB();
        const store = db
            .transaction([STORE_TRANSACTIONS], "readonly")
            .objectStore(STORE_TRANSACTIONS);
        const since = Math.max(filter.since ?? 0, page.after?.createdAt ?? 0);
        const request = store
            .index("addressCreatedAt")
            .openCursor(
                IDBKeyRange.bound(
                    [filter.address, since],
                    [filter.address, Number.MAX_SAFE_INTEGER],
                ),
            );
        return new Promise((resolve, reject) => {
            const rows: ArkTransaction[] = [];
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                try {
                    const cursor = request.result;
                    if (!cursor) {
                        resolve(
                            pageResult(rows, page.limit, (tx) => ({
                                createdAt: tx.createdAt,
                                key: tx.key,
                            })),
                        );
                        return;
                    }
                    const tx = cursor.value as ArkTransaction;
                    if (
                        page.after === undefined ||
                        compareHistoryCursors(
                            { createdAt: tx.createdAt, key: tx.key },
                            page.after,
                        ) > 0
                    )
                        rows.push(tx);
                    if (rows.length > page.limit) {
                        resolve(
                            pageResult(rows, page.limit, (tx) => ({
                                createdAt: tx.createdAt,
                                key: tx.key,
                            })),
                        );
                        return;
                    }
                    cursor.continue();
                } catch (error) {
                    reject(error);
                }
            };
        });
    }

    async saveTransactions(address: string, txs: ArkTransaction[]): Promise<void> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_TRANSACTIONS], "readwrite");
            const store = transaction.objectStore(STORE_TRANSACTIONS);
            for (const tx of txs) {
                store.put({
                    address,
                    ...tx,
                    keyBoardingTxid: tx.key.boardingTxid,
                    keyCommitmentTxid: tx.key.commitmentTxid,
                    keyArkTxid: tx.key.arkTxid,
                });
            }
            await awaitTransaction(transaction);
        } catch (error) {
            console.error(`Failed to save transactions for address ${address}:`, error);
            throw error;
        }
    }

    async deleteTransactions(address: string): Promise<void> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_TRANSACTIONS], "readwrite");
            deleteByIndex(transaction.objectStore(STORE_TRANSACTIONS), "address", address);
            await awaitTransaction(transaction);
        } catch (error) {
            console.error(`Failed to clear transactions for address ${address}:`, error);
            throw error;
        }
    }

    async getWalletState(): Promise<WalletState | null> {
        try {
            const db = await this.getDB();
            const store = db
                .transaction([STORE_WALLET_STATE], "readonly")
                .objectStore(STORE_WALLET_STATE);
            const result = await promisifyRequest<{ data?: WalletState } | undefined>(
                store.get("state"),
            );
            return result?.data ?? null;
        } catch (error) {
            console.error("Failed to get wallet state:", error);
            return null;
        }
    }

    async saveWalletState(state: WalletState): Promise<void> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_WALLET_STATE], "readwrite");
            transaction.objectStore(STORE_WALLET_STATE).put({ key: "state", data: state });
            await awaitTransaction(transaction);
        } catch (error) {
            console.error("Failed to save wallet state:", error);
            throw error;
        }
    }

    private getDB(): Promise<IDBDatabase> {
        return this.connection.get();
    }
}

// Post-migration every row has `script`, but the backfill is idempotent: if a
// legacy row is ever read before the upgrade-path completes, derive `script`
// from `address` the same way the indexer would have populated it.
//
// The same read-time repair covers the canonical VTXO facts. Rows here are whole objects, so a
// row written before those facts existed still carries the legacy `virtualStatus` blob and no
// column migration can reach it — `normalizeVtxo` no longer reads that blob, so without this a
// swept row comes back `isSwept: false`, spendable, until the first indexer sync.
function deserializeVtxoWithBackfill({ unspent: _unspent, ...o }: RawVtxoRow): ExtendedVirtualCoin {
    if (!o.script) {
        o = { ...o, script: scriptFromArkAddress(o.address) };
    }
    const facts = legacyFactsOfRow(o);
    // Blanks only: a row that carries its own values keeps them, the projection being lossier.
    if (facts) {
        o = {
            ...o,
            isSpent: o.isSpent ?? facts.isSpent,
            isSwept: facts.isSwept,
            isPreconfirmed: facts.isPreconfirmed,
            commitmentTxIds: o.commitmentTxIds ?? facts.commitmentTxIds,
            expiresAt: o.expiresAt ?? facts.expiresAt,
            expiresAtHeight: o.expiresAtHeight ?? facts.expiresAtHeight,
        };
    }
    return deserializeVtxo(o);
}

const storedVtxoOf = (raw: RawVtxoRow): StoredVtxo => ({
    address: raw.address,
    vtxo: deserializeVtxoWithBackfill(raw),
});

const scriptVtxoCursorOf = (row: StoredVtxo): ScriptVtxoCursor => ({
    address: row.address,
    txid: row.vtxo.txid,
    vout: row.vtxo.vout,
});

type RawVtxoRow = SerializedVtxo & { address: string; unspent?: 1 };
