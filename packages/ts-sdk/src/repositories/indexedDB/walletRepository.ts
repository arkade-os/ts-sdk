import { ExtendedCoin, ExtendedVirtualCoin, ArkTransaction } from "../../wallet";
import { WalletRepository, WalletState, VtxoRepositoryKey } from "../walletRepository";
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
import { initDatabase } from "./schema";
import { scriptFromArkAddress } from "../scriptFromAddress";
import { DEFAULT_DB_NAME } from "../../worker/browser/utils";
import { isVtxoForScript } from "../../contracts/vtxoOwnership";
import { isVtxoSpent } from "../../wallet/vtxo";

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

    async getVtxos(address: string): Promise<ExtendedVirtualCoin[]> {
        try {
            const db = await this.getDB();
            const store = db.transaction([STORE_VTXOS], "readonly").objectStore(STORE_VTXOS);
            const results = await promisifyRequest<(SerializedVtxo & { address: string })[]>(
                store.index("address").getAll(address),
            );
            // A bad row (e.g. a legacy VTXO whose address can't be decoded
            // during backfill) throws here, in ordinary async code, so the
            // outer catch reports it rather than it being lost inside an IDB
            // event handler.
            return (results || []).map(deserializeVtxoWithBackfill);
        } catch (error) {
            console.error(`Failed to get VTXOs for address ${address}:`, error);
            return [];
        }
    }

    async saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_VTXOS], "readwrite");
            const store = transaction.objectStore(STORE_VTXOS);
            for (const vtxo of vtxos) {
                const serialized: SerializedVtxo = serializeVtxo(vtxo);
                store.put({ address, ...serialized });
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

    async getVtxosForScript(script: string): Promise<ExtendedVirtualCoin[]> {
        return this.getVtxosForScripts([script]);
    }

    async getVtxosForScripts(
        scripts: string[],
        options?: { unspentOnly?: boolean },
    ): Promise<ExtendedVirtualCoin[]> {
        const unique = [...new Set(scripts)];
        if (unique.length === 0) return [];
        try {
            const db = await this.getDB();
            const rows = options?.unspentOnly
                ? await this.readUnspentCandidates(db, unique)
                : await getAllByIndexValues<RawVtxoRow>(this.vtxoStore(db), "script", unique);

            const selected = new Set(unique);
            const byOutpoint = new Map<string, RawVtxoRow>();
            for (const row of rows) {
                if (!selected.has(row.script!)) continue;
                const key = `${row.script}:${row.txid}:${row.vout}`;
                const existing = byOutpoint.get(key);
                if (!existing || shouldReplaceVtxo(existing, row)) byOutpoint.set(key, row);
            }

            const result: ExtendedVirtualCoin[] = [];
            for (const row of byOutpoint.values()) {
                // After the dedup, not before: another bucket's terminal row can win.
                if (options?.unspentOnly && (row.isSpent || row.spentBy || row.settledBy)) {
                    continue;
                }
                const vtxo = deserializeVtxoWithBackfill(row);
                if (!options?.unspentOnly || !isVtxoSpent(vtxo)) result.push(vtxo);
            }
            return result;
        } catch (error) {
            console.error("Failed to get VTXOs for scripts:", error);
            throw error;
        }
    }

    // Candidates for an `unspentOnly` read: keyed, not cloned, so spent history
    // is never read. Strictly negative — a non-empty `spentBy`/`settledBy` proves
    // a terminal row, an unset one costs a read and never hides a coin.
    // (`isSpent` indexes nothing: booleans are invalid IndexedDB keys.)
    private async readUnspentCandidates(db: IDBDatabase, scripts: string[]): Promise<RawVtxoRow[]> {
        const keyStore = this.vtxoStore(db);
        const nonEmpty = IDBKeyRange.lowerBound("", true);
        const [spentBy, settledBy, ...perScript] = await Promise.all([
            promisifyRequest<IDBValidKey[]>(keyStore.index("spentBy").getAllKeys(nonEmpty)),
            promisifyRequest<IDBValidKey[]>(keyStore.index("settledBy").getAllKeys(nonEmpty)),
            ...scripts.map((script) =>
                promisifyRequest<IDBValidKey[]>(keyStore.index("script").getAllKeys(script)),
            ),
        ]);
        const terminal = new Set<string>();
        for (const key of spentBy) terminal.add(primaryKeyId(key));
        for (const key of settledBy) terminal.add(primaryKeyId(key));

        const wanted: IDBValidKey[] = [];
        let total = 0;
        for (const keys of perScript) {
            total += keys.length;
            const byOutpoint = new Map<string, IDBValidKey[]>();
            for (const key of keys) {
                const [, txid, vout] = key as [string, string, number];
                const group = byOutpoint.get(`${txid}:${vout}`);
                if (group) group.push(key);
                else byOutpoint.set(`${txid}:${vout}`, [key]);
            }
            for (const group of byOutpoint.values()) {
                // Whole group: a duplicate's terminal copy must be able to win.
                if (group.length > 1 || !terminal.has(primaryKeyId(group[0]))) {
                    wanted.push(...group);
                }
            }
        }

        const skipped = total - wanted.length;
        if (skipped < wanted.length) {
            return getAllByIndexValues<RawVtxoRow>(this.vtxoStore(db), "script", scripts);
        }
        const rowStore = this.vtxoStore(db);
        const rows = await Promise.all(
            wanted.map((key) => promisifyRequest<RawVtxoRow | undefined>(rowStore.get(key))),
        );
        return rows.filter((row): row is RawVtxoRow => row !== undefined);
    }

    private vtxoStore(db: IDBDatabase): IDBObjectStore {
        return db.transaction([STORE_VTXOS], "readonly").objectStore(STORE_VTXOS);
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

    async getUtxos(address: string): Promise<ExtendedCoin[]> {
        try {
            const db = await this.getDB();
            const store = db.transaction([STORE_UTXOS], "readonly").objectStore(STORE_UTXOS);
            const results = await promisifyRequest(store.index("address").getAll(address));
            return (results || []).map(deserializeUtxo);
        } catch (error) {
            console.error(`Failed to get UTXOs for address ${address}:`, error);
            return [];
        }
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

    async getTransactionHistory(address: string): Promise<ArkTransaction[]> {
        try {
            const db = await this.getDB();
            const store = db
                .transaction([STORE_TRANSACTIONS], "readonly")
                .objectStore(STORE_TRANSACTIONS);
            const results = await promisifyRequest<ArkTransaction[]>(
                store.index("address").getAll(address),
            );
            return (results || []).sort((a, b) => a.createdAt - b.createdAt);
        } catch (error) {
            console.error(`Failed to get transaction history for address ${address}:`, error);
            return [];
        }
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
function deserializeVtxoWithBackfill(o: SerializedVtxo & { address: string }): ExtendedVirtualCoin {
    if (!o.script) {
        o = { ...o, script: scriptFromArkAddress(o.address) };
    }
    return deserializeVtxo(o);
}

type RawVtxoRow = SerializedVtxo & { address: string };

function primaryKeyId(key: IDBValidKey): string {
    return (key as IDBValidKey[]).join("\u0000");
}

function isCanonicalRow(row: RawVtxoRow): boolean {
    try {
        return scriptFromArkAddress(row.address) === row.script;
    } catch {
        return false;
    }
}

function shouldReplaceVtxo(existing: RawVtxoRow, incoming: RawVtxoRow): boolean {
    const existingCanonical = isCanonicalRow(existing);
    const incomingCanonical = isCanonicalRow(incoming);

    if (incomingCanonical && !existingCanonical) return true;
    if (existingCanonical && !incomingCanonical) return false;

    // Tie on canonicality, check lifecycle completeness
    const existingWeight = getLifecycleWeight(existing);
    const incomingWeight = getLifecycleWeight(incoming);

    if (incomingWeight > existingWeight) return true;
    if (existingWeight > incomingWeight) return false;

    // Tie on weight, stable sort by address
    return incoming.address < existing.address;
}

function getLifecycleWeight(v: RawVtxoRow): number {
    let weight = 0;
    if (v.isSpent !== undefined) weight += 1;
    if (v.spentBy) weight += 2;
    if (v.settledBy) weight += 2;
    if (v.arkTxId) weight += 2;
    return weight;
}
