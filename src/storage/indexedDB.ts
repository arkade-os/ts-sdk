import type { StorageAdapter } from "./index";

const LATEST_SCHEMA_VERSION = 2;

const STORE_FALLBACK = "storage";
const STORE_VTXOS = "vtxos";
const STORE_UTXOS = "utxos";
const STORE_TRANSACTIONS = "transactions";
const STORE_WALLET_STATE = "walletState";
const STORE_CONTRACT_DATA = "contractData";

const PREFIX_VTXOS = "vtxos:";
const PREFIX_UTXOS = "utxos:";
const PREFIX_TRANSACTIONS = "tx:";
const PREFIX_CONTRACT = "contract:";

interface OrderedRecord<T> {
    id: string;
    address: string;
    order: number;
    payload: T;
    [extra: string]: any;
}

interface WalletStateRecord<T = unknown> {
    key: string;
    payload: T;
}

interface ContractRecord {
    id: string;
    contractId: string;
    entryKey: string;
    value: string;
}

type JsonArray = Array<Record<string, any>>;
type AddressRecordDescriptor = {
    idSuffix: string;
    extra?: Record<string, any>;
};

export class IndexedDBStorageAdapter implements StorageAdapter {
    private dbName: string;
    private version: number;
    private db: IDBDatabase | null = null;

    constructor(dbName: string, version: number = LATEST_SCHEMA_VERSION) {
        this.dbName = dbName;
        this.version = Math.max(version, LATEST_SCHEMA_VERSION);
    }

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;

        const indexedDB = (
            globalThis as typeof globalThis & {
                indexedDB?: IDBFactory;
            }
        ).indexedDB;

        if (!indexedDB) {
            throw new Error("IndexedDB is not available in this environment");
        }

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                this.db.onversionchange = () => {
                    if (this.db) {
                        this.db.close();
                        this.db = null;
                    }
                };
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = request.result;
                const oldVersion =
                    typeof event.oldVersion === "number" ? event.oldVersion : 0;

                // Always ensure the fallback KV store exists for backward compatibility.
                if (!db.objectStoreNames.contains(STORE_FALLBACK)) {
                    db.createObjectStore(STORE_FALLBACK);
                }

                if (oldVersion < 2) {
                    if (!db.objectStoreNames.contains(STORE_VTXOS)) {
                        const store = db.createObjectStore(STORE_VTXOS, {
                            keyPath: "id",
                        });
                        store.createIndex("address", "address", {
                            unique: false,
                        });
                    }

                    if (!db.objectStoreNames.contains(STORE_UTXOS)) {
                        const store = db.createObjectStore(STORE_UTXOS, {
                            keyPath: "id",
                        });
                        store.createIndex("address", "address", {
                            unique: false,
                        });
                    }

                    if (!db.objectStoreNames.contains(STORE_TRANSACTIONS)) {
                        const store = db.createObjectStore(STORE_TRANSACTIONS, {
                            keyPath: "id",
                        });
                        store.createIndex("address", "address", {
                            unique: false,
                        });
                    }

                    if (!db.objectStoreNames.contains(STORE_WALLET_STATE)) {
                        db.createObjectStore(STORE_WALLET_STATE, {
                            keyPath: "key",
                        });
                    }

                    if (!db.objectStoreNames.contains(STORE_CONTRACT_DATA)) {
                        const store = db.createObjectStore(
                            STORE_CONTRACT_DATA,
                            { keyPath: "id" }
                        );
                        store.createIndex("contractId", "contractId", {
                            unique: false,
                        });
                    }
                }
            };
        });
    }

    async getItem(key: string): Promise<string | null> {
        try {
            if (key.startsWith(PREFIX_VTXOS)) {
                return await this.getAddressScopedArray(
                    STORE_VTXOS,
                    PREFIX_VTXOS,
                    key,
                    (item) => this.buildOutpointDescriptor(item)
                );
            }

            if (key.startsWith(PREFIX_UTXOS)) {
                return await this.getAddressScopedArray(
                    STORE_UTXOS,
                    PREFIX_UTXOS,
                    key,
                    (item) => this.buildOutpointDescriptor(item)
                );
            }

            if (key.startsWith(PREFIX_TRANSACTIONS)) {
                return await this.getAddressScopedArray(
                    STORE_TRANSACTIONS,
                    PREFIX_TRANSACTIONS,
                    key,
                    (item) => this.buildTransactionDescriptor(item)
                );
            }

            if (key === "wallet:state") {
                return await this.getWalletState();
            }

            if (key.startsWith(PREFIX_CONTRACT)) {
                return await this.getContractData(key);
            }

            return await this.getFromFallback(key);
        } catch (error) {
            await this.logFailure("getItem", error, key);
            return null;
        }
    }

    async setItem(key: string, value: string): Promise<void> {
        try {
            if (key.startsWith(PREFIX_VTXOS)) {
                await this.setAddressScopedArray(
                    STORE_VTXOS,
                    PREFIX_VTXOS,
                    key,
                    value,
                    (item) => this.buildOutpointDescriptor(item)
                );
                return;
            }

            if (key.startsWith(PREFIX_UTXOS)) {
                await this.setAddressScopedArray(
                    STORE_UTXOS,
                    PREFIX_UTXOS,
                    key,
                    value,
                    (item) => this.buildOutpointDescriptor(item)
                );
                return;
            }

            if (key.startsWith(PREFIX_TRANSACTIONS)) {
                await this.setAddressScopedArray(
                    STORE_TRANSACTIONS,
                    PREFIX_TRANSACTIONS,
                    key,
                    value,
                    (item) => this.buildTransactionDescriptor(item)
                );
                return;
            }

            if (key === "wallet:state") {
                await this.setWalletState(value);
                return;
            }

            if (key.startsWith(PREFIX_CONTRACT)) {
                await this.setContractData(key, value);
                return;
            }

            await this.writeToFallback(key, value);
        } catch (error) {
            await this.logFailure("setItem", error, key);
            throw error;
        }
    }

    async removeItem(key: string): Promise<void> {
        try {
            if (key.startsWith(PREFIX_VTXOS)) {
                await this.clearAddressScopedEntries(
                    STORE_VTXOS,
                    key,
                    PREFIX_VTXOS
                );
                await this.deleteFromFallback(key);
                return;
            }

            if (key.startsWith(PREFIX_UTXOS)) {
                await this.clearAddressScopedEntries(
                    STORE_UTXOS,
                    key,
                    PREFIX_UTXOS
                );
                await this.deleteFromFallback(key);
                return;
            }

            if (key.startsWith(PREFIX_TRANSACTIONS)) {
                await this.clearAddressScopedEntries(
                    STORE_TRANSACTIONS,
                    key,
                    PREFIX_TRANSACTIONS
                );
                await this.deleteFromFallback(key);
                return;
            }

            if (key === "wallet:state") {
                await this.removeWalletState();
                await this.deleteFromFallback(key);
                return;
            }

            if (key.startsWith(PREFIX_CONTRACT)) {
                await this.removeContractData(key);
                await this.deleteFromFallback(key);
                return;
            }

            await this.deleteFromFallback(key);
        } catch (error) {
            await this.logFailure("removeItem", error, key);
        }
    }

    async clear(): Promise<void> {
        try {
            const db = await this.getDB();
            const storeNames = [
                STORE_FALLBACK,
                STORE_VTXOS,
                STORE_UTXOS,
                STORE_TRANSACTIONS,
                STORE_WALLET_STATE,
                STORE_CONTRACT_DATA,
            ].filter((name) => db.objectStoreNames.contains(name));

            if (storeNames.length === 0) return;

            const transaction = db.transaction(storeNames, "readwrite");
            for (const name of storeNames) {
                transaction.objectStore(name).clear();
            }
            await this.transactionComplete(transaction);
        } catch (error) {
            await this.logFailure("clear", error);
        }
    }

    private buildOutpointDescriptor(
        item: Record<string, any>
    ): AddressRecordDescriptor | null {
        const txid = item?.txid;
        const vout = item?.vout;
        if (typeof txid !== "string" || typeof vout !== "number") {
            return null;
        }
        return {
            idSuffix: `${txid}:${vout}`,
            extra: { txid, vout },
        };
    }

    private buildTransactionDescriptor(
        item: Record<string, any>
    ): AddressRecordDescriptor | null {
        const txKey = item?.key;
        if (typeof txKey !== "string") return null;
        return { idSuffix: txKey, extra: { txKey } };
    }

    private async getAddressScopedArray(
        storeName: string,
        prefix: string,
        key: string,
        migrationBuilder?: (
            item: Record<string, any>,
            index: number
        ) => AddressRecordDescriptor | null
    ): Promise<string | null> {
        const address = key.slice(prefix.length);
        if (!address) return null;

        const records = await this.getAddressRecords(storeName, address);
        if (records.length === 0) {
            const fallback = await this.getFromFallback(key);
            if (fallback) {
                if (migrationBuilder) {
                    try {
                        await this.setAddressScopedArray(
                            storeName,
                            prefix,
                            key,
                            fallback,
                            migrationBuilder
                        );
                    } catch {
                        // If migration fails we keep fallback data untouched.
                    }
                }
                return fallback;
            }
            return null;
        }

        records.sort((a, b) => a.order - b.order);
        return JSON.stringify(records.map((record) => record.payload));
    }

    private async setAddressScopedArray(
        storeName: string,
        prefix: string,
        key: string,
        value: string,
        idBuilder: (
            item: Record<string, any>,
            index: number
        ) => AddressRecordDescriptor | null
    ): Promise<void> {
        const address = key.slice(prefix.length);
        if (!address) {
            await this.writeToFallback(key, value);
            return;
        }

        let parsed: JsonArray;
        try {
            const raw = JSON.parse(value);
            if (!Array.isArray(raw)) {
                throw new Error("Expected array payload");
            }
            parsed = raw as JsonArray;
        } catch {
            await this.writeToFallback(key, value);
            return;
        }

        const descriptors: AddressRecordDescriptor[] = [];
        for (let idx = 0; idx < parsed.length; idx++) {
            const descriptor = idBuilder(parsed[idx], idx);
            if (!descriptor) {
                await this.writeToFallback(key, value);
                return;
            }
            descriptors.push(descriptor);
        }

        const db = await this.getDB();
        if (!db.objectStoreNames.contains(storeName)) {
            await this.writeToFallback(key, value);
            return;
        }

        const transaction = db.transaction([storeName], "readwrite");
        const store = transaction.objectStore(storeName);
        const index = store.index("address");
        const existing = await this.requestToPromise<
            OrderedRecord<Record<string, any>>[]
        >(index.getAll(address));

        const keepIds = new Set<string>();

        parsed.forEach((item, idx) => {
            const descriptor = descriptors[idx];
            const id = `${address}:${descriptor.idSuffix}`;
            keepIds.add(id);

            const record: OrderedRecord<Record<string, any>> = {
                id,
                address,
                order: idx,
                payload: item,
                ...(descriptor.extra ?? {}),
            };

            store.put(record);
        });

        for (const record of existing) {
            if (!keepIds.has(record.id)) {
                store.delete(record.id);
            }
        }

        await this.transactionComplete(transaction);
        await this.deleteFromFallback(key);
    }

    private async clearAddressScopedEntries(
        storeName: string,
        key: string,
        prefix: string
    ): Promise<void> {
        const address = key.slice(prefix.length);
        if (!address) return;

        const db = await this.getDB();
        if (!db.objectStoreNames.contains(storeName)) return;

        const transaction = db.transaction([storeName], "readwrite");
        const store = transaction.objectStore(storeName);
        const index = store.index("address");
        const records = await this.requestToPromise<
            OrderedRecord<Record<string, any>>[]
        >(index.getAll(address));

        for (const record of records) {
            store.delete(record.id);
        }

        await this.transactionComplete(transaction);
    }

    private async getWalletState(): Promise<string | null> {
        const db = await this.getDB();
        if (db.objectStoreNames.contains(STORE_WALLET_STATE)) {
            const transaction = db.transaction(
                [STORE_WALLET_STATE],
                "readonly"
            );
            const store = transaction.objectStore(STORE_WALLET_STATE);
            const record = await this.requestToPromise<
                WalletStateRecord | undefined
            >(store.get("wallet:state"));
            await this.transactionComplete(transaction);

            if (record && record.payload !== undefined) {
                return JSON.stringify(record.payload);
            }
        }

        const fallback = await this.getFromFallback("wallet:state");
        if (fallback) {
            try {
                await this.setWalletState(fallback);
            } catch {
                // ignore migration errors
            }
            return fallback;
        }
        return null;
    }

    private async setWalletState(value: string): Promise<void> {
        let parsed: unknown;
        try {
            parsed = JSON.parse(value);
        } catch {
            await this.writeToFallback("wallet:state", value);
            return;
        }

        const db = await this.getDB();
        if (!db.objectStoreNames.contains(STORE_WALLET_STATE)) {
            await this.writeToFallback("wallet:state", value);
            return;
        }

        const transaction = db.transaction([STORE_WALLET_STATE], "readwrite");
        const store = transaction.objectStore(STORE_WALLET_STATE);
        store.put({ key: "wallet:state", payload: parsed });
        await this.transactionComplete(transaction);
        await this.deleteFromFallback("wallet:state");
    }

    private async removeWalletState(): Promise<void> {
        const db = await this.getDB();
        if (!db.objectStoreNames.contains(STORE_WALLET_STATE)) return;

        const transaction = db.transaction([STORE_WALLET_STATE], "readwrite");
        const store = transaction.objectStore(STORE_WALLET_STATE);
        store.delete("wallet:state");
        await this.transactionComplete(transaction);
    }

    private async getContractData(key: string): Promise<string | null> {
        const parsed = this.parseContractKey(key);
        if (!parsed) {
            return await this.getFromFallback(key);
        }

        const db = await this.getDB();
        if (db.objectStoreNames.contains(STORE_CONTRACT_DATA)) {
            const transaction = db.transaction(
                [STORE_CONTRACT_DATA],
                "readonly"
            );
            const store = transaction.objectStore(STORE_CONTRACT_DATA);
            const record = await this.requestToPromise<
                ContractRecord | undefined
            >(store.get(parsed.id));
            await this.transactionComplete(transaction);

            if (record) {
                return record.value;
            }
        }

        const fallback = await this.getFromFallback(key);
        if (fallback) {
            try {
                await this.setContractData(key, fallback);
            } catch {
                // ignore migration errors
            }
            return fallback;
        }
        return null;
    }

    private async setContractData(key: string, value: string): Promise<void> {
        const parsed = this.parseContractKey(key);
        if (!parsed) {
            await this.writeToFallback(key, value);
            return;
        }

        const db = await this.getDB();
        if (!db.objectStoreNames.contains(STORE_CONTRACT_DATA)) {
            await this.writeToFallback(key, value);
            return;
        }

        const transaction = db.transaction([STORE_CONTRACT_DATA], "readwrite");
        const store = transaction.objectStore(STORE_CONTRACT_DATA);
        const record: ContractRecord = {
            id: parsed.id,
            contractId: parsed.contractId,
            entryKey: parsed.entryKey,
            value,
        };
        store.put(record);
        await this.transactionComplete(transaction);
        await this.deleteFromFallback(key);
    }

    private async removeContractData(key: string): Promise<void> {
        const parsed = this.parseContractKey(key);
        if (!parsed) return;

        const db = await this.getDB();
        if (!db.objectStoreNames.contains(STORE_CONTRACT_DATA)) return;

        const transaction = db.transaction([STORE_CONTRACT_DATA], "readwrite");
        const store = transaction.objectStore(STORE_CONTRACT_DATA);
        store.delete(parsed.id);
        await this.transactionComplete(transaction);
    }

    /**
     * Parses contract storage keys shaped as `contract:<contractId>:<entryKey>`.
     * The entry key portion may contain additional `:` separators.
     * Returns `null` when the key is not namespaced for contract data.
     */
    private parseContractKey(
        key: string
    ): { id: string; contractId: string; entryKey: string } | null {
        if (!key.startsWith(PREFIX_CONTRACT)) return null;
        const [, contractId, ...rest] = key.split(":");
        if (!contractId || rest.length === 0) return null;
        const entryKey = rest.join(":");
        return {
            id: `${contractId}:${entryKey}`,
            contractId,
            entryKey,
        };
    }

    private async getAddressRecords(
        storeName: string,
        address: string
    ): Promise<OrderedRecord<Record<string, any>>[]> {
        const db = await this.getDB();
        if (!db.objectStoreNames.contains(storeName)) return [];

        const transaction = db.transaction([storeName], "readonly");
        const store = transaction.objectStore(storeName);
        const index = store.index("address");
        const result = await this.requestToPromise<
            OrderedRecord<Record<string, any>>[]
        >(index.getAll(address));
        await this.transactionComplete(transaction);
        return result ?? [];
    }

    private async writeToFallback(key: string, value: string): Promise<void> {
        const db = await this.getDB();
        if (!db.objectStoreNames.contains(STORE_FALLBACK)) {
            throw new Error("Fallback object store is missing");
        }

        const transaction = db.transaction([STORE_FALLBACK], "readwrite");
        const store = transaction.objectStore(STORE_FALLBACK);
        store.put(value, key);
        await this.transactionComplete(transaction);
    }

    private async getFromFallback(key: string): Promise<string | null> {
        const db = await this.getDB();
        if (!db.objectStoreNames.contains(STORE_FALLBACK)) return null;

        const transaction = db.transaction([STORE_FALLBACK], "readonly");
        const store = transaction.objectStore(STORE_FALLBACK);
        const result = await this.requestToPromise<string | undefined>(
            store.get(key)
        );
        await this.transactionComplete(transaction);
        return result ?? null;
    }

    private async deleteFromFallback(key: string): Promise<void> {
        const db = await this.getDB();
        if (!db.objectStoreNames.contains(STORE_FALLBACK)) return;

        const transaction = db.transaction([STORE_FALLBACK], "readwrite");
        const store = transaction.objectStore(STORE_FALLBACK);
        store.delete(key);
        await this.transactionComplete(transaction);
    }

    private async logFailure(
        operation: string,
        error: unknown,
        key?: string
    ): Promise<void> {
        try {
            const context: Record<string, unknown> = { operation };
            if (key) {
                const hashed = await this.hashKey(key);
                if (hashed) {
                    context.keyHash = hashed;
                } else {
                    const [prefix] = key.split(":");
                    context.keyPrefix = prefix ?? "unknown";
                }
            }
            console.debug("IndexedDB operation failed", context, error);
        } catch {
            console.debug("IndexedDB operation failed", { operation }, error);
        }
    }

    private async hashKey(key: string): Promise<string | null> {
        try {
            const subtle = globalThis.crypto?.subtle;
            if (!subtle) return null;

            const digest = await subtle.digest(
                "SHA-256",
                new TextEncoder().encode(key)
            );
            return Array.from(new Uint8Array(digest))
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
        } catch {
            return null;
        }
    }

    private transactionComplete(transaction: IDBTransaction): Promise<void> {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = () =>
                reject(transaction.error || new Error("Transaction aborted"));
            transaction.onerror = () =>
                reject(transaction.error || new Error("Transaction failed"));
        });
    }

    private requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () =>
                reject(request.error || new Error("Request failed"));
        });
    }
}
