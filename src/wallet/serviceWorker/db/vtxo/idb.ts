import { VtxoRepository } from ".";
import { ExtendedVirtualCoin } from "../../..";

const DB_NAME = "wallet-db";
const STORE_NAME = "vtxos";
const DB_VERSION = 1;

export class IndexedDBVtxoRepository implements VtxoRepository {
    private db: IDBDatabase | null = null;

    constructor() {
        this.initDB();
    }

    private initDB(): Promise<void> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => {
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, {
                        keyPath: ["txid", "vout"],
                    });
                    store.createIndex("state", "virtualStatus.state", {
                        unique: false,
                    });
                }
            };
        });
    }

    async addOrUpdate(vtxos: ExtendedVirtualCoin[]): Promise<void> {
        if (!this.db) {
            await this.initDB();
            if (!this.db) throw new Error("Failed to initialize database");
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(STORE_NAME, "readwrite");
            const store = transaction.objectStore(STORE_NAME);

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
            await this.initDB();
            if (!this.db) throw new Error("Failed to initialize database");
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(STORE_NAME, "readwrite");
            const store = transaction.objectStore(STORE_NAME);
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getSpendableVtxos(): Promise<ExtendedVirtualCoin[]> {
        if (!this.db) {
            await this.initDB();
            if (!this.db) throw new Error("Failed to initialize database");
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(STORE_NAME, "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const stateIndex = store.index("state");

            // Get both settled and pending vtxos
            const settledRequest = stateIndex.getAll("settled");
            const pendingRequest = stateIndex.getAll("pending");

            Promise.all([
                new Promise<ExtendedVirtualCoin[]>(
                    (resolveSettled, rejectSettled) => {
                        settledRequest.onsuccess = () => {
                            resolveSettled(
                                settledRequest.result as ExtendedVirtualCoin[]
                            );
                        };
                        settledRequest.onerror = () =>
                            rejectSettled(settledRequest.error);
                    }
                ),
                new Promise<ExtendedVirtualCoin[]>(
                    (resolvePending, rejectPending) => {
                        pendingRequest.onsuccess = () => {
                            resolvePending(
                                pendingRequest.result as ExtendedVirtualCoin[]
                            );
                        };
                        pendingRequest.onerror = () =>
                            rejectPending(pendingRequest.error);
                    }
                ),
            ])
                .then(([settledVtxos, pendingVtxos]) => {
                    resolve([...settledVtxos, ...pendingVtxos]);
                })
                .catch(reject);
        });
    }

    async getAllVtxos(): Promise<{
        spendable: ExtendedVirtualCoin[];
        spent: ExtendedVirtualCoin[];
    }> {
        if (!this.db) {
            await this.initDB();
            if (!this.db) throw new Error("Failed to initialize database");
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(STORE_NAME, "readonly");
            const store = transaction.objectStore(STORE_NAME);
            const stateIndex = store.index("state");

            // Get all vtxos by state
            const settledRequest = stateIndex.getAll("settled");
            const pendingRequest = stateIndex.getAll("pending");
            const spentRequest = stateIndex.getAll("swept");

            Promise.all([
                new Promise<ExtendedVirtualCoin[]>(
                    (resolveSettled, rejectSettled) => {
                        settledRequest.onsuccess = () => {
                            resolveSettled(
                                settledRequest.result as ExtendedVirtualCoin[]
                            );
                        };
                        settledRequest.onerror = () =>
                            rejectSettled(settledRequest.error);
                    }
                ),
                new Promise<ExtendedVirtualCoin[]>(
                    (resolvePending, rejectPending) => {
                        pendingRequest.onsuccess = () => {
                            resolvePending(
                                pendingRequest.result as ExtendedVirtualCoin[]
                            );
                        };
                        pendingRequest.onerror = () =>
                            rejectPending(pendingRequest.error);
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
                .then(([settledVtxos, pendingVtxos, spentVtxos]) => {
                    resolve({
                        spendable: [...settledVtxos, ...pendingVtxos],
                        spent: spentVtxos,
                    });
                })
                .catch(reject);
        });
    }
}
