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
import type { OpenDatabaseOptions } from "./db";
import { InMemoryDatabase } from "./inMemoryDatabase";

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
export class IndexedDBWalletRepository implements WalletRepository {
    private db: IDBDatabase | null = null;
    private inMemoryDb: InMemoryDatabase | null = null;

    constructor(
        private readonly dbName: string = DEFAULT_DB_NAME,
        private readonly options?: OpenDatabaseOptions
    ) {}

    static async create(
        dbName: string = DEFAULT_DB_NAME,
        options?: OpenDatabaseOptions
    ): Promise<IndexedDBWalletRepository> {
        const repository = new IndexedDBWalletRepository(dbName, options);
        if (!options?.inMemory) {
            await repository.getDB();
        }
        return repository;
    }

    private async getDB(): Promise<IDBDatabase> {
        if (this.options?.inMemory) {
            throw new Error(
                "IndexedDB is not available for in-memory repositories"
            );
        }
        if (this.db) return this.db;
        this.db = await openDatabase(this.dbName, this.options);
        return this.db;
    }

    private getInMemoryDb(): InMemoryDatabase {
        if (!this.options?.inMemory) {
            throw new Error("In-memory database not enabled");
        }
        if (!this.inMemoryDb) {
            this.inMemoryDb = new InMemoryDatabase();
        }
        return this.inMemoryDb;
    }

    async close(): Promise<void> {
        if (this.options?.inMemory) {
            // Set it free for garbage collection
            this.inMemoryDb = null;
            return;
        }
        if (!this.db) return;
        closeDatabase(this.dbName, this.db);
        this.db.close();
        this.db = null;
    }

    [Symbol.dispose](): void {
        void this.close();
    }

    [Symbol.asyncDispose](): Promise<void> {
        return this.close();
    }

    // VTXO management
    async getVtxos(address: string): Promise<ExtendedVirtualCoin[]> {
        try {
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                const results = db.getAllByIndex(
                    STORE_VTXOS,
                    "address",
                    address
                ) as SerializedVtxo[];
                return results.map(deserializeVtxo);
            }
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
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                vtxos.forEach((vtxo) => {
                    const serialized: SerializedVtxo = serializeVtxo(vtxo);
                    const item = { address, ...serialized };
                    db.put(STORE_VTXOS, item);
                });
                return;
            }
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
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                db.deleteWhere(
                    STORE_VTXOS,
                    (item) =>
                        typeof item === "object" &&
                        item !== null &&
                        (item as { address?: string }).address === address
                );
                return;
            }
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

    // UTXO management
    async getUtxos(address: string): Promise<ExtendedCoin[]> {
        try {
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                const results = db.getAllByIndex(
                    STORE_UTXOS,
                    "address",
                    address
                ) as SerializedUtxo[];
                return results.map(deserializeUtxo);
            }
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
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                utxos.forEach((utxo) => {
                    const serialized = serializeUtxo(utxo);
                    const item = { address, ...serialized };
                    db.put(STORE_UTXOS, item);
                });
                return;
            }
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
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                db.deleteWhere(
                    STORE_UTXOS,
                    (item) =>
                        typeof item === "object" &&
                        item !== null &&
                        (item as { address?: string }).address === address
                );
                return;
            }
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

    // Transaction history
    async getTransactionHistory(address: string): Promise<ArkTransaction[]> {
        try {
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                const results = db.getAllByIndex(
                    STORE_TRANSACTIONS,
                    "address",
                    address
                ) as ArkTransaction[];
                return results.sort((a, b) => a.createdAt - b.createdAt);
            }
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
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
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
                return;
            }
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
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                db.deleteWhere(
                    STORE_TRANSACTIONS,
                    (item) =>
                        typeof item === "object" &&
                        item !== null &&
                        (item as { address?: string }).address === address
                );
                return;
            }
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

    // Wallet state
    async getWalletState(): Promise<WalletState | null> {
        try {
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                const result = db.get<{ data?: WalletState }>(
                    STORE_WALLET_STATE,
                    "state"
                );
                return result?.data ?? null;
            }
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
            if (this.options?.inMemory) {
                const db = this.getInMemoryDb();
                db.put(STORE_WALLET_STATE, { key: "state", data: state });
                return;
            }
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
}
