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
import { initDatabase, unspentFlag } from "./schema";
import { scriptFromArkAddress } from "../scriptFromAddress";
import { legacyFactsOfRow } from "../legacyVtxoFacts";
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
                ? await getAllByIndexValues<RawVtxoRow>(
                      this.vtxoStore(db),
                      "scriptUnspent",
                      unique.map((script) => [script, 1]),
                  )
                : await getAllByIndexValues<RawVtxoRow>(this.vtxoStore(db), "script", unique);

            const selected = new Set(unique);
            const byOutpoint = new Map<string, RawVtxoRow>();
            for (const row of rows) {
                if (!selected.has(row.script!)) continue;
                const key = `${row.script}:${row.txid}:${row.vout}`;
                const existing = byOutpoint.get(key);
                if (!existing || shouldReplaceVtxo(existing, row)) byOutpoint.set(key, row);
            }
            if (options?.unspentOnly && byOutpoint.size > 0) {
                // A newer terminal copy in another address bucket is not in the index.
                const txids = [...new Set([...byOutpoint.values()].map((row) => row.txid))];
                const store = this.vtxoStore(db);
                for (const row of await getAllByIndexValues<RawVtxoRow>(store, "txid", txids)) {
                    const key = `${row.script}:${row.txid}:${row.vout}`;
                    const existing = byOutpoint.get(key);
                    if (existing && shouldReplaceVtxo(existing, row)) byOutpoint.set(key, row);
                }
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

type RawVtxoRow = SerializedVtxo & { address: string; unspent?: 1 };

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
