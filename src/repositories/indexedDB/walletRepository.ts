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

/**
 * IndexedDB-based implementation of WalletRepository.
 */
export class IndexedDBWalletRepository implements WalletRepository {
    private db: IDBDatabase | null = null;

    constructor(private readonly dbName: string = DEFAULT_DB_NAME) {}

    static async create(
        dbName: string = DEFAULT_DB_NAME
    ): Promise<IndexedDBWalletRepository> {
        const repository = new IndexedDBWalletRepository(dbName);
        await repository.getDB();
        return repository;
    }

    async close(): Promise<void> {
        if (!this.db) return;
        closeDatabase(this.dbName, this.db);
        this.db.close();
        this.db = null;
    }

    async [Symbol.asyncDispose](): Promise<void> {
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
