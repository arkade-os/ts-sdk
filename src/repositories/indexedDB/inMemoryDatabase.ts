import {
    STORE_COLLECTIONS,
    STORE_CONTRACT_DATA,
    STORE_TRANSACTIONS,
    STORE_UTXOS,
    STORE_VTXOS,
    STORE_WALLET_STATE,
} from "./schema";

type StoreName =
    | typeof STORE_VTXOS
    | typeof STORE_UTXOS
    | typeof STORE_TRANSACTIONS
    | typeof STORE_WALLET_STATE
    | typeof STORE_CONTRACT_DATA
    | typeof STORE_COLLECTIONS;

type StoreKeyPath = string | string[];

const storeKeyPaths: Record<StoreName, StoreKeyPath> = {
    [STORE_VTXOS]: ["address", "txid", "vout"],
    [STORE_UTXOS]: ["address", "txid", "vout"],
    [STORE_TRANSACTIONS]: [
        "address",
        "keyBoardingTxid",
        "keyCommitmentTxid",
        "keyArkTxid",
    ],
    [STORE_WALLET_STATE]: "key",
    [STORE_CONTRACT_DATA]: ["contractId", "key"],
    [STORE_COLLECTIONS]: "contractType",
};

export class InMemoryDatabase {
    private readonly stores: Record<StoreName, Map<string, unknown>> = {
        [STORE_VTXOS]: new Map(),
        [STORE_UTXOS]: new Map(),
        [STORE_TRANSACTIONS]: new Map(),
        [STORE_WALLET_STATE]: new Map(),
        [STORE_CONTRACT_DATA]: new Map(),
        [STORE_COLLECTIONS]: new Map(),
    };

    put<T extends Record<string, any>>(
        storeName: StoreName,
        value: T
    ): unknown {
        const key = computeKey(storeName, value);
        this.stores[storeName].set(stringifyKey(key), value);
        return key;
    }

    get<T>(storeName: StoreName, key: unknown): T | undefined {
        return this.stores[storeName].get(stringifyKey(key)) as T | undefined;
    }

    delete(storeName: StoreName, key: unknown): void {
        this.stores[storeName].delete(stringifyKey(key));
    }

    clear(storeName: StoreName): void {
        this.stores[storeName].clear();
    }

    getAll(storeName: StoreName): unknown[] {
        return Array.from(this.stores[storeName].values());
    }

    getAllByIndex(
        storeName: StoreName,
        indexName: string,
        value: unknown
    ): unknown[] {
        return this.getAll(storeName).filter(
            (item) =>
                typeof item === "object" &&
                item !== null &&
                (item as Record<string, unknown>)[indexName] === value
        );
    }

    deleteWhere(
        storeName: StoreName,
        predicate: (item: unknown) => boolean
    ): void {
        const store = this.stores[storeName];
        for (const [key, value] of store.entries()) {
            if (predicate(value)) {
                store.delete(key);
            }
        }
    }

    clearAll(): void {
        for (const store of Object.values(this.stores)) {
            store.clear();
        }
    }
}

function computeKey(storeName: StoreName, value: Record<string, any>): unknown {
    const keyPath = storeKeyPaths[storeName];
    if (Array.isArray(keyPath)) {
        return keyPath.map((key) => value[key]);
    }
    return value[keyPath];
}

function stringifyKey(key: unknown): string {
    return typeof key === "string" ? key : JSON.stringify(key);
}
