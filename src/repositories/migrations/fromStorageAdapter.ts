import { StorageAdapter } from "../../storage";
import { WalletRepository } from "../walletRepository";
import { ContractRepository } from "../contractRepository";
import { WalletRepositoryImpl } from "./walletRepositoryImpl";
import { ContractRepositoryImpl } from "./contractRepositoryImpl";

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
    fresh: ContractRepository
): Promise<void> {
    const migration = await storageAdapter.getItem(MIGRATION_KEY("contract"));
    if (migration == "done") return;

    const legacy = new ContractRepositoryImpl(storageAdapter);
    const keys = await listStorageKeys(storageAdapter);

    console.log(
        "Migrating contract repository from storage adapter:",
        legacy,
        keys
    );

    for (const key of keys) {
        if (!key.startsWith(CONTRACT_PREFIX)) continue;
        const match = key.match(/^contract:([^:]+):(.+)$/);
        if (!match) continue;
        const [, contractId, dataKey] = match;
        const value = await legacy.getContractData(contractId, dataKey);
        if (value === null) continue;
        await fresh.setContractData(contractId, dataKey, value);
    }

    for (const key of keys) {
        if (!key.startsWith(COLLECTION_PREFIX)) continue;
        const match = key.match(/^collection:(.+)$/);
        if (!match) continue;
        const [, contractType] = match;
        const collection =
            await legacy.getContractCollection<Record<string, unknown>>(
                contractType
            );
        if (!collection.length) continue;
        const idField = inferIdField(collection);
        for (const item of collection) {
            await fresh.saveToContractCollection(contractType, item, idField);
        }
    }

    await storageAdapter.setItem(MIGRATION_KEY("contract"), "done");
}

async function listStorageKeys(
    storageAdapter: StorageAdapter
): Promise<string[]> {
    const adapterAny = storageAdapter as any;

    if (adapterAny.store instanceof Map) {
        // trying our luck with in-memory storage
        return Array.from(adapterAny.store.keys());
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

function inferIdField<T extends Record<string, unknown>>(
    items: ReadonlyArray<T>
): keyof T {
    const candidate = items.find((item) => item && typeof item === "object") as
        | T
        | undefined;
    if (!candidate) {
        throw new Error("Cannot infer id field for empty collection");
    }
    if ("id" in candidate) return "id" as keyof T;
    if ("txid" in candidate) return "txid" as keyof T;
    if ("key" in candidate) return "key" as keyof T;
    throw new Error("Cannot infer id field for contract collection");
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
