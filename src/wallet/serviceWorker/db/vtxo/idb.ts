import { VtxoRepository } from ".";
import { ExtendedVirtualCoin } from "../../..";

export class IndexedDBVtxoRepository implements VtxoRepository {
    static readonly DB_NAME = "wallet-db";
    static readonly STORE_NAME = "vtxos";
    static readonly DB_VERSION = 1;

    static delete(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const request = indexedDB.deleteDatabase(
                    IndexedDBVtxoRepository.DB_NAME
                );

                request.onblocked = () => {
                    // If blocked, wait a bit and try again
                    setTimeout(() => {
                        const retryRequest = indexedDB.deleteDatabase(
                            IndexedDBVtxoRepository.DB_NAME
                        );
                        retryRequest.onsuccess = () => resolve();
                        retryRequest.onerror = () =>
                            reject(
                                retryRequest.error ||
                                    new Error("Failed to delete database")
                            );
                    }, 100);
                };

                request.onsuccess = () => {
                    resolve();
                };

                request.onerror = () => {
                    reject(
                        request.error || new Error("Failed to delete database")
                    );
                };
            } catch (error) {
                reject(
                    error instanceof Error
                        ? error
                        : new Error("Failed to delete database")
                );
            }
        });
    }

    private db: IDBDatabase | null = null;

    async close(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    async open(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(
                IndexedDBVtxoRepository.DB_NAME,
                IndexedDBVtxoRepository.DB_VERSION
            );

            request.onerror = () => {
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (
                    !db.objectStoreNames.contains(
                        IndexedDBVtxoRepository.STORE_NAME
                    )
                ) {
                    const store = db.createObjectStore(
                        IndexedDBVtxoRepository.STORE_NAME,
                        {
                            keyPath: ["txid", "vout"],
                        }
                    );
                    store.createIndex("state", "virtualStatus.state", {
                        unique: false,
                    });
                    store.createIndex("spentBy", "spentBy", {
                        unique: false,
                    });
                }
            };
        });
    }

    async addOrUpdate(vtxos: ExtendedVirtualCoin[]): Promise<void> {
        if (!this.db) {
            throw new Error("Database not opened");
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(
                IndexedDBVtxoRepository.STORE_NAME,
                "readwrite"
            );
            const store = transaction.objectStore(
                IndexedDBVtxoRepository.STORE_NAME
            );

            const requests = vtxos.map((vtxo) => {
                return new Promise<void>((resolveRequest, rejectRequest) => {
                    const request = store.put(vtxo);
                    request.onsuccess = () => resolveRequest();
                    request.onerror = () => rejectRequest(request.error);
                });
            });

            Promise.all(requests)
                .then(() => resolve())
                .catch(reject);
        });
    }

    async deleteAll(): Promise<void> {
        if (!this.db) {
            throw new Error("Database not opened");
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(
                IndexedDBVtxoRepository.STORE_NAME,
                "readwrite"
            );
            const store = transaction.objectStore(
                IndexedDBVtxoRepository.STORE_NAME
            );
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getSpendableVtxos(): Promise<ExtendedVirtualCoin[]> {
        if (!this.db) {
            throw new Error("Database not opened");
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(
                IndexedDBVtxoRepository.STORE_NAME,
                "readonly"
            );
            const store = transaction.objectStore(
                IndexedDBVtxoRepository.STORE_NAME
            );
            const spentByIndex = store.index("spentBy");

            // Get vtxos where spentBy is empty string
            const request = spentByIndex.getAll(IDBKeyRange.only(""));

            request.onsuccess = () => {
                resolve(request.result as ExtendedVirtualCoin[]);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getSweptVtxos(): Promise<ExtendedVirtualCoin[]> {
        if (!this.db) {
            throw new Error("Database not opened");
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(
                IndexedDBVtxoRepository.STORE_NAME,
                "readonly"
            );
            const store = transaction.objectStore(
                IndexedDBVtxoRepository.STORE_NAME
            );
            const stateIndex = store.index("state");

            // Get vtxos where state is "swept"
            const request = stateIndex.getAll(IDBKeyRange.only("swept"));

            request.onsuccess = () => {
                resolve(request.result as ExtendedVirtualCoin[]);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getSpentVtxos(): Promise<ExtendedVirtualCoin[]> {
        if (!this.db) {
            throw new Error("Database not opened");
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(
                IndexedDBVtxoRepository.STORE_NAME,
                "readonly"
            );
            const store = transaction.objectStore(
                IndexedDBVtxoRepository.STORE_NAME
            );
            const spentByIndex = store.index("spentBy");

            // Get vtxos where spentBy is not empty string
            const request = spentByIndex.getAll(
                IDBKeyRange.lowerBound("", true)
            );

            request.onsuccess = () => {
                resolve(request.result as ExtendedVirtualCoin[]);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async getAllVtxos(): Promise<{
        spendable: ExtendedVirtualCoin[];
        spent: ExtendedVirtualCoin[];
    }> {
        if (!this.db) {
            throw new Error("Database not opened");
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(
                IndexedDBVtxoRepository.STORE_NAME,
                "readonly"
            );
            const store = transaction.objectStore(
                IndexedDBVtxoRepository.STORE_NAME
            );
            const spentByIndex = store.index("spentBy");

            // Get vtxos where spentBy is empty string
            const spendableRequest = spentByIndex.getAll(IDBKeyRange.only(""));

            // Get all vtxos where spentBy is populated
            const spentRequest = spentByIndex.getAll(
                IDBKeyRange.lowerBound("", true)
            );

            Promise.all([
                new Promise<ExtendedVirtualCoin[]>(
                    (resolveSpendable, rejectSpendable) => {
                        spendableRequest.onsuccess = () => {
                            resolveSpendable(
                                spendableRequest.result as ExtendedVirtualCoin[]
                            );
                        };
                        spendableRequest.onerror = () =>
                            rejectSpendable(spendableRequest.error);
                    }
                ),
                new Promise<ExtendedVirtualCoin[]>(
                    (resolveSpent, rejectSpent) => {
                        spentRequest.onsuccess = () => {
                            resolveSpent(
                                spentRequest.result as ExtendedVirtualCoin[]
                            );
                        };
                        spentRequest.onerror = () =>
                            rejectSpent(spentRequest.error);
                    }
                ),
            ])
                .then(([spendableVtxos, spentVtxos]) => {
                    resolve({
                        spendable: spendableVtxos,
                        spent: spentVtxos,
                    });
                })
                .catch(reject);
        });
    }
}
