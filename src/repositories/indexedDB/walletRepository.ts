import {
    ExtendedCoin,
    ExtendedVirtualCoin,
    ArkTransaction,
} from "../../wallet";
import { WalletRepository, WalletState } from "../walletRepository";
import { DEFAULT_DB_NAME } from "../../wallet/serviceWorker/utils";
import {
    openDatabase,
    closeDatabase,
    STORE_VTXOS,
    STORE_UTXOS,
    STORE_TRANSACTIONS,
    STORE_WALLET_STATE,
    serializeVtxo,
    serializeUtxo,
    deserializeVtxo,
    deserializeUtxo,
    SerializedVtxo,
    SerializedUtxo,
} from "./db";
import { InMemoryDatabase } from "./inMemoryDatabase";

type WalletStore = {
    init?: () => Promise<void>;
    close: () => Promise<void>;
    getVtxos: (address: string) => Promise<ExtendedVirtualCoin[]>;
    saveVtxos: (address: string, vtxos: ExtendedVirtualCoin[]) => Promise<void>;
    clearVtxos: (address: string) => Promise<void>;
    getUtxos: (address: string) => Promise<ExtendedCoin[]>;
    saveUtxos: (address: string, utxos: ExtendedCoin[]) => Promise<void>;
    clearUtxos: (address: string) => Promise<void>;
    getTransactionHistory: (address: string) => Promise<ArkTransaction[]>;
    saveTransactions: (address: string, txs: ArkTransaction[]) => Promise<void>;
    clearTransactions: (address: string) => Promise<void>;
    getWalletState: () => Promise<WalletState | null>;
    saveWalletState: (state: WalletState) => Promise<void>;
};

class IndexedDbWalletStore implements WalletStore {
    private db: IDBDatabase | null = null;

    constructor(private readonly dbName: string) {}

    async init(): Promise<void> {
        await this.getDB();
    }

    async close(): Promise<void> {
        if (!this.db) return;
        closeDatabase(this.dbName, this.db);
        this.db.close();
        this.db = null;
    }

    async getVtxos(address: string): Promise<ExtendedVirtualCoin[]> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_VTXOS], "readonly");
                const store = transaction.objectStore(STORE_VTXOS);
                const index = store.index("address");
                const request: IDBRequest<SerializedVtxo[]> =
                    index.getAll(address);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const results = request.result || [];
                    const vtxos = results.map(deserializeVtxo);
                    resolve(vtxos);
                };
            });
        } catch (error) {
            console.error(`Failed to get VTXOs for address ${address}:`, error);
            return [];
        }
    }

    async saveVtxos(
        address: string,
        vtxos: ExtendedVirtualCoin[]
    ): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_VTXOS], "readwrite");
                const store = transaction.objectStore(STORE_VTXOS);

                const promises = vtxos.map((vtxo) => {
                    return new Promise<void>((resolveItem, rejectItem) => {
                        const serialized: SerializedVtxo = serializeVtxo(vtxo);
                        const item = {
                            address,
                            ...serialized,
                        };
                        const request = store.put(item);

                        request.onerror = () => rejectItem(request.error);
                        request.onsuccess = () => resolveItem();
                    });
                });

                Promise.all(promises)
                    .then(() => resolve())
                    .catch(reject);

                transaction.onerror = () => reject(transaction.error);
            });
        } catch (error) {
            console.error(
                `Failed to save VTXOs for address ${address}:`,
                error
            );
            throw error;
        }
    }

    async clearVtxos(address: string): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_VTXOS], "readwrite");
                const store = transaction.objectStore(STORE_VTXOS);
                const index = store.index("address");
                const request = index.openCursor(IDBKeyRange.only(address));

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (cursor) {
                        cursor.delete();
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
            });
        } catch (error) {
            console.error(
                `Failed to clear VTXOs for address ${address}:`,
                error
            );
            throw error;
        }
    }

    async getUtxos(address: string): Promise<ExtendedCoin[]> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_UTXOS], "readonly");
                const store = transaction.objectStore(STORE_UTXOS);
                const index = store.index("address");
                const request = index.getAll(address);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const results = request.result || [];
                    const utxos = results.map(deserializeUtxo);
                    resolve(utxos);
                };
            });
        } catch (error) {
            console.error(`Failed to get UTXOs for address ${address}:`, error);
            return [];
        }
    }

    async saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_UTXOS], "readwrite");
                const store = transaction.objectStore(STORE_UTXOS);

                const promises = utxos.map((utxo) => {
                    return new Promise<void>((resolveItem, rejectItem) => {
                        const serialized = serializeUtxo(utxo);
                        const item = {
                            address,
                            ...serialized,
                        };
                        const request = store.put(item);

                        request.onerror = () => rejectItem(request.error);
                        request.onsuccess = () => resolveItem();
                    });
                });

                Promise.all(promises)
                    .then(() => resolve())
                    .catch(reject);

                transaction.onerror = () => reject(transaction.error);
            });
        } catch (error) {
            console.error(
                `Failed to save UTXOs for address ${address}:`,
                error
            );
            throw error;
        }
    }

    async clearUtxos(address: string): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction([STORE_UTXOS], "readwrite");
                const store = transaction.objectStore(STORE_UTXOS);
                const index = store.index("address");
                const request = index.openCursor(IDBKeyRange.only(address));

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (cursor) {
                        cursor.delete();
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
            });
        } catch (error) {
            console.error(
                `Failed to clear UTXOs for address ${address}:`,
                error
            );
            throw error;
        }
    }

    async getTransactionHistory(address: string): Promise<ArkTransaction[]> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_TRANSACTIONS],
                    "readonly"
                );
                const store = transaction.objectStore(STORE_TRANSACTIONS);
                const index = store.index("address");
                const request = index.getAll(address);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const results = request.result || [];
                    resolve(results.sort((a, b) => a.createdAt - b.createdAt));
                };
            });
        } catch (error) {
            console.error(
                `Failed to get transaction history for address ${address}:`,
                error
            );
            return [];
        }
    }

    async saveTransactions(
        address: string,
        txs: ArkTransaction[]
    ): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_TRANSACTIONS],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_TRANSACTIONS);

                // Queue all put operations
                txs.forEach((tx) => {
                    const item = {
                        address,
                        ...tx,
                        keyBoardingTxid: tx.key.boardingTxid,
                        keyCommitmentTxid: tx.key.commitmentTxid,
                        keyArkTxid: tx.key.arkTxid,
                    };
                    store.put(item);
                });

                // Handle transaction completion
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () =>
                    reject(new Error("Transaction aborted"));
            });
        } catch (error) {
            console.error(
                `Failed to save transactions for address ${address}:`,
                error
            );
            throw error;
        }
    }

    async clearTransactions(address: string): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_TRANSACTIONS],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_TRANSACTIONS);
                const index = store.index("address");
                const request = index.openCursor(IDBKeyRange.only(address));

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (cursor) {
                        cursor.delete();
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
            });
        } catch (error) {
            console.error(
                `Failed to clear transactions for address ${address}:`,
                error
            );
            throw error;
        }
    }

    async getWalletState(): Promise<WalletState | null> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_WALLET_STATE],
                    "readonly"
                );
                const store = transaction.objectStore(STORE_WALLET_STATE);
                const request = store.get("state");

                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const result = request.result;
                    if (result && result.data) {
                        resolve(result.data);
                    } else {
                        resolve(null);
                    }
                };
            });
        } catch (error) {
            console.error("Failed to get wallet state:", error);
            return null;
        }
    }

    async saveWalletState(state: WalletState): Promise<void> {
        try {
            const db = await this.getDB();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction(
                    [STORE_WALLET_STATE],
                    "readwrite"
                );
                const store = transaction.objectStore(STORE_WALLET_STATE);
                const item = {
                    key: "state",
                    data: state,
                };
                const request = store.put(item);

                request.onerror = () => reject(request.error);
                request.onsuccess = () => resolve();
            });
        } catch (error) {
            console.error("Failed to save wallet state:", error);
            throw error;
        }
    }

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;
        this.db = await openDatabase(this.dbName);
        return this.db;
    }
}

class InMemoryWalletStore implements WalletStore {
    private db: InMemoryDatabase | null = new InMemoryDatabase();

    async close(): Promise<void> {
        this.db = null;
    }

    async getVtxos(address: string): Promise<ExtendedVirtualCoin[]> {
        const db = this.getDb();
        const results = db.getAllByIndex(
            STORE_VTXOS,
            "address",
            address
        ) as SerializedVtxo[];
        return results.map(deserializeVtxo);
    }

    async saveVtxos(
        address: string,
        vtxos: ExtendedVirtualCoin[]
    ): Promise<void> {
        const db = this.getDb();
        vtxos.forEach((vtxo) => {
            const serialized: SerializedVtxo = serializeVtxo(vtxo);
            const item = { address, ...serialized };
            db.put(STORE_VTXOS, item);
        });
    }

    async clearVtxos(address: string): Promise<void> {
        const db = this.getDb();
        db.deleteWhere(
            STORE_VTXOS,
            (item) =>
                typeof item === "object" &&
                item !== null &&
                (item as { address?: string }).address === address
        );
    }

    async getUtxos(address: string): Promise<ExtendedCoin[]> {
        const db = this.getDb();
        const results = db.getAllByIndex(
            STORE_UTXOS,
            "address",
            address
        ) as SerializedUtxo[];
        return results.map(deserializeUtxo);
    }

    async saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void> {
        const db = this.getDb();
        utxos.forEach((utxo) => {
            const serialized = serializeUtxo(utxo);
            const item = { address, ...serialized };
            db.put(STORE_UTXOS, item);
        });
    }

    async clearUtxos(address: string): Promise<void> {
        const db = this.getDb();
        db.deleteWhere(
            STORE_UTXOS,
            (item) =>
                typeof item === "object" &&
                item !== null &&
                (item as { address?: string }).address === address
        );
    }

    async getTransactionHistory(address: string): Promise<ArkTransaction[]> {
        const db = this.getDb();
        const results = db.getAllByIndex(
            STORE_TRANSACTIONS,
            "address",
            address
        ) as ArkTransaction[];
        return results.sort((a, b) => a.createdAt - b.createdAt);
    }

    async saveTransactions(
        address: string,
        txs: ArkTransaction[]
    ): Promise<void> {
        const db = this.getDb();
        txs.forEach((tx) => {
            const item = {
                address,
                ...tx,
                keyBoardingTxid: tx.key.boardingTxid,
                keyCommitmentTxid: tx.key.commitmentTxid,
                keyArkTxid: tx.key.arkTxid,
            };
            db.put(STORE_TRANSACTIONS, item);
        });
    }

    async clearTransactions(address: string): Promise<void> {
        const db = this.getDb();
        db.deleteWhere(
            STORE_TRANSACTIONS,
            (item) =>
                typeof item === "object" &&
                item !== null &&
                (item as { address?: string }).address === address
        );
    }

    async getWalletState(): Promise<WalletState | null> {
        const db = this.getDb();
        const result = db.get<{ data?: WalletState }>(
            STORE_WALLET_STATE,
            "state"
        );
        return result?.data ?? null;
    }

    async saveWalletState(state: WalletState): Promise<void> {
        const db = this.getDb();
        db.put(STORE_WALLET_STATE, { key: "state", data: state });
    }

    private getDb(): InMemoryDatabase {
        if (!this.db) {
            throw new Error("In-memory database has been closed");
        }
        return this.db;
    }
}

/**
 * IndexedDB-based implementation of WalletRepository.
 *
 * This repository stores wallet data (VTXOs, UTXOs, transactions, and wallet state)
 * in IndexedDB with optimized indexes for complex queries. It supports automatic
 * migration from the legacy storage format (version 1) to the new indexed format (version 2).
 *
 * @example
 * ```typescript
 * const repository = new IndexedDBWalletRepository('my-wallet-db');
 * const vtxos = await repository.getVtxos(address);
 * ```
 */
/**
 * IndexedDB-based implementation of WalletRepository.
 *
 * Pass `{ inMemory: true }` to use a simple in-memory store (per instance).
 */
export class IndexedDBWalletRepository implements WalletRepository {
    private readonly store: WalletStore;

    constructor(
        dbName: string = DEFAULT_DB_NAME,
        options?: { inMemory?: boolean }
    ) {
        this.store = options?.inMemory
            ? new InMemoryWalletStore()
            : new IndexedDbWalletStore(dbName);
    }

    static async create(
        dbName: string = DEFAULT_DB_NAME,
        options?: { inMemory?: boolean }
    ): Promise<IndexedDBWalletRepository> {
        const repository = new IndexedDBWalletRepository(dbName, options);
        await repository.store.init?.();
        return repository;
    }

    async close(): Promise<void> {
        await this.store.close();
    }

    [Symbol.dispose](): void {
        void this.close();
    }

    [Symbol.asyncDispose](): Promise<void> {
        return this.close();
    }

    getVtxos(address: string): Promise<ExtendedVirtualCoin[]> {
        return this.store.getVtxos(address);
    }

    saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void> {
        return this.store.saveVtxos(address, vtxos);
    }

    clearVtxos(address: string): Promise<void> {
        return this.store.clearVtxos(address);
    }

    getUtxos(address: string): Promise<ExtendedCoin[]> {
        return this.store.getUtxos(address);
    }

    saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void> {
        return this.store.saveUtxos(address, utxos);
    }

    clearUtxos(address: string): Promise<void> {
        return this.store.clearUtxos(address);
    }

    getTransactionHistory(address: string): Promise<ArkTransaction[]> {
        return this.store.getTransactionHistory(address);
    }

    saveTransactions(address: string, txs: ArkTransaction[]): Promise<void> {
        return this.store.saveTransactions(address, txs);
    }

    clearTransactions(address: string): Promise<void> {
        return this.store.clearTransactions(address);
    }

    getWalletState(): Promise<WalletState | null> {
        return this.store.getWalletState();
    }

    saveWalletState(state: WalletState): Promise<void> {
        return this.store.saveWalletState(state);
    }
}
