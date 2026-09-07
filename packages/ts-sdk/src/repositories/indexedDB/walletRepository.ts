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
import { awaitTransaction, deleteByIndex, promisifyRequest } from "./idbUtils";
import { createManagedConnection, ManagedConnection } from "./managedConnection";
import { initDatabase } from "./schema";
import { scriptFromArkAddress } from "../scriptFromAddress";
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
        try {
            const db = await this.getDB();
            const store = db.transaction([STORE_VTXOS], "readonly").objectStore(STORE_VTXOS);
            const results = await promisifyRequest<(SerializedVtxo & { address: string })[]>(
                store.index("script").getAll(script),
            );

            // Defensive filter: only rows whose script matches.
            const matching = (results || []).filter((r) => r.script === script);

            // Dedup same outpoint rows across address buckets. Work on raw rows
            // so the address field is available for the canonicality tiebreaker.
            const byOutpoint = new Map<string, SerializedVtxo & { address: string }>();
            for (const row of matching) {
                const outpoint = `${row.txid}:${row.vout}`;
                const existing = byOutpoint.get(outpoint);
                if (!existing) {
                    byOutpoint.set(outpoint, row);
                    continue;
                }
                if (shouldReplaceVtxo(existing, row)) {
                    byOutpoint.set(outpoint, row);
                }
            }
            return Array.from(byOutpoint.values()).map(deserializeVtxoWithBackfill);
        } catch (error) {
            console.error(`Failed to get VTXOs for script ${script}:`, error);
            throw error;
        }
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
