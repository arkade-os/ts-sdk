import { StorageAdapter } from "../../storage";
import { WalletRepository } from "../walletRepository";
import { DEFAULT_DB_NAME } from "../../wallet/serviceWorker/utils";
import {
    STORE_CONTRACTS,
    STORE_CONTRACT_COLLECTIONS,
    openDatabase,
} from "../indexedDB/db";

import { WalletRepositoryImpl } from "./walletRepositoryImpl";

const MIGRATION_KEY = (repoType: "wallet" | "contract") =>
    `migration-from-storage-adapter-${repoType}`;

export async function migrateWalletRepository(
    storageAdapter: StorageAdapter,
    fresh: WalletRepository,
    addresses: string[]
): Promise<void> {
    const migration = await storageAdapter.getItem(MIGRATION_KEY("wallet"));
    if (migration == "done") return;

    const old = new WalletRepositoryImpl(storageAdapter);

    const walletData = await old.getWalletState();

    const addressesData = await Promise.all(
        addresses.map(async (address) => {
            const vtxos = await old.getVtxos(address);
            const utxos = await old.getUtxos(address);
            const txs = await old.getTransactionHistory(address);
            return { address, vtxos, utxos, txs };
        })
    );

    await Promise.all([
        walletData && fresh.saveWalletState(walletData),
        ...addressesData.map((addressData) => {
            return Promise.all([
                fresh.saveVtxos(addressData.address, addressData.vtxos),
                fresh.saveUtxos(addressData.address, addressData.utxos),
                fresh.saveTransactions(addressData.address, addressData.txs),
            ]);
        }),
    ]);

    await storageAdapter.setItem(MIGRATION_KEY("wallet"), "done");
}

const CONTRACT_PREFIX = "contract:";
const COLLECTION_PREFIX = "collection:";

export async function migrateContractRepository(
    storageAdapter: StorageAdapter,
    dbName: string = DEFAULT_DB_NAME
): Promise<void> {
    const migration = await storageAdapter.getItem(MIGRATION_KEY("contract"));
    if (migration == "done") return;

    const keys = await listStorageKeys(storageAdapter);
    const contractEntries: Array<{ key: string; value: string }> = [];
    const collectionEntries: Array<{ key: string; value: string }> = [];

    for (const key of keys) {
        if (
            !key.startsWith(CONTRACT_PREFIX) &&
            !key.startsWith(COLLECTION_PREFIX)
        ) {
            continue;
        }
        const value = await storageAdapter.getItem(key);
        if (value === null) continue;
        if (key.startsWith(CONTRACT_PREFIX)) {
            contractEntries.push({ key, value });
        } else {
            collectionEntries.push({ key, value });
        }
    }

    if (contractEntries.length || collectionEntries.length) {
        const db = await openDatabase(dbName);
        await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction(
                [STORE_CONTRACTS, STORE_CONTRACT_COLLECTIONS],
                "readwrite"
            );
            const contractsStore = transaction.objectStore(STORE_CONTRACTS);
            const collectionsStore = transaction.objectStore(
                STORE_CONTRACT_COLLECTIONS
            );

            contractEntries.forEach((entry) => {
                contractsStore.put(entry);
            });
            collectionEntries.forEach((entry) => {
                collectionsStore.put(entry);
            });

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () =>
                reject(new Error("Transaction aborted"));
        });
    }

    await storageAdapter.setItem(MIGRATION_KEY("contract"), "done");
}

async function listStorageKeys(
    storageAdapter: StorageAdapter
): Promise<string[]> {
    const adapterAny = storageAdapter as any;

    if (adapterAny.store instanceof Map) {
        return Array.from(adapterAny.store.keys());
    }

    if (typeof window !== "undefined" && window.localStorage) {
        try {
            window.localStorage.length;
            const keys: string[] = [];
            for (let i = 0; i < window.localStorage.length; i += 1) {
                const key = window.localStorage.key(i);
                if (key) keys.push(key);
            }
            if (keys.length) return keys;
        } catch {
            // ignore and fall through
        }
    }

    if (adapterAny.dbName && typeof indexedDB !== "undefined") {
        const dbName = adapterAny.dbName as string;
        const version = (adapterAny.version as number) ?? undefined;
        return await listIndexedDbKeys(dbName, version);
    }

    if (adapterAny.AsyncStorage?.getAllKeys) {
        return await adapterAny.AsyncStorage.getAllKeys();
    }

    throw new Error("Storage adapter does not support key enumeration");
}

async function listIndexedDbKeys(
    dbName: string,
    version?: number
): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, version);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction(["storage"], "readonly");
            const store = transaction.objectStore("storage");
            const keysRequest = store.getAllKeys();
            keysRequest.onerror = () => reject(keysRequest.error);
            keysRequest.onsuccess = () => {
                resolve(keysRequest.result as string[]);
            };
        };
    });
}
