import { describe, it, expect } from "vitest";
import { IndexedDBStorageAdapter } from "../src/storage/indexedDB";

const waitForTransaction = (tx: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });

const getAllRecords = <T>(store: IDBObjectStore) =>
    new Promise<T[]>((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error);
    });

const openDatabase = (dbName: string) =>
    new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

const withDb = async <T>(
    dbName: string,
    fn: (db: IDBDatabase) => Promise<T>
): Promise<T> => {
    const db = await openDatabase(dbName);
    try {
        return await fn(db);
    } finally {
        db.close();
    }
};

const readStoreRecords = async <T>(
    dbName: string,
    storeName: string
): Promise<T[]> =>
    withDb(dbName, async (db) => {
        const tx = db.transaction([storeName], "readonly");
        const store = tx.objectStore(storeName);
        const records = await getAllRecords<T>(store);
        await waitForTransaction(tx);
        return records;
    });

describe("IndexedDBStorageAdapter", () => {
    const randomDbName = () => `arkade-sdk-test-${Date.now()}-${Math.random()}`;

    const cleanup = async (dbName: string) =>
        new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(dbName);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
        });

    it("stores and retrieves vtxos using structured object store", async () => {
        const dbName = randomDbName();
        const adapter = new IndexedDBStorageAdapter(dbName);
        const key = "vtxos:addr1";
        const payload = [
            { txid: "a".repeat(64), vout: 0, foo: "bar" },
            { txid: "b".repeat(64), vout: 1, foo: "baz" },
        ];

        await adapter.setItem(key, JSON.stringify(payload));

        const stored = await adapter.getItem(key);
        expect(stored).toEqual(JSON.stringify(payload));

        const records = await readStoreRecords<any>(dbName, "vtxos");
        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({
            address: "addr1",
            txid: payload[0].txid,
            vout: payload[0].vout,
            order: 0,
        });

        await cleanup(dbName);
    });

    it("removes address scoped data while preserving other entries", async () => {
        const dbName = randomDbName();
        const adapter = new IndexedDBStorageAdapter(dbName);
        const keyA = "vtxos:addrA";
        const keyB = "vtxos:addrB";
        const sample = [{ txid: "c".repeat(64), vout: 0 }];

        await adapter.setItem(keyA, JSON.stringify(sample));
        await adapter.setItem(keyB, JSON.stringify(sample));

        await adapter.removeItem(keyA);

        const records = await readStoreRecords<any>(dbName, "vtxos");
        expect(records).toHaveLength(1);
        expect(records[0].address).toBe("addrB");

        await cleanup(dbName);
    });

    it("removes utxos scoped data while preserving other entries", async () => {
        const dbName = randomDbName();
        const adapter = new IndexedDBStorageAdapter(dbName);
        const keyA = "utxos:addrA";
        const keyB = "utxos:addrB";
        const sample = [{ txid: "d".repeat(64), vout: 2 }];

        await adapter.setItem(keyA, JSON.stringify(sample));
        await adapter.setItem(keyB, JSON.stringify(sample));

        await adapter.removeItem(keyA);

        const records = await readStoreRecords<any>(dbName, "utxos");
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            address: "addrB",
            txid: sample[0].txid,
            vout: sample[0].vout,
        });

        await cleanup(dbName);
    });

    it("removes wallet state", async () => {
        const dbName = randomDbName();
        const adapter = new IndexedDBStorageAdapter(dbName);

        const state = { foo: "bar" };
        await adapter.setItem("wallet:state", JSON.stringify(state));
        expect(await adapter.getItem("wallet:state")).toEqual(
            JSON.stringify(state)
        );

        await adapter.removeItem("wallet:state");

        const records = await readStoreRecords<any>(dbName, "walletState");
        expect(records).toHaveLength(0);

        await cleanup(dbName);
    });

    it("migrates legacy fallback data on first read", async () => {
        const dbName = randomDbName();
        const adapter = new IndexedDBStorageAdapter(dbName);
        const key = "tx:addr-migrate";
        const payload = [{ key: "tx-key-1", amount: 1 }];

        await adapter.getItem("init");

        await withDb(dbName, async (db) => {
            const fallbackTx = db.transaction(["storage"], "readwrite");
            fallbackTx.objectStore("storage").put(JSON.stringify(payload), key);
            await waitForTransaction(fallbackTx);
        });

        const result = await adapter.getItem(key);
        expect(result).toEqual(JSON.stringify(payload));

        await withDb(dbName, async (db) => {
            const structuredTx = db.transaction(["transactions"], "readonly");
            const structuredStore = structuredTx.objectStore("transactions");
            const structuredRecords = await getAllRecords<any>(structuredStore);
            await waitForTransaction(structuredTx);
            expect(structuredRecords).toHaveLength(1);
            expect(structuredRecords[0]).toMatchObject({
                address: "addr-migrate",
                txKey: "tx-key-1",
                order: 0,
            });

            const fallbackCheckTx = db.transaction(["storage"], "readonly");
            const fallbackStore = fallbackCheckTx.objectStore("storage");
            const fallbackEntries = await getAllRecords<any>(fallbackStore);
            await waitForTransaction(fallbackCheckTx);
            expect(fallbackEntries).toEqual([]);
        });

        await cleanup(dbName);
    });

    it("clears all stores", async () => {
        const dbName = randomDbName();
        const adapter = new IndexedDBStorageAdapter(dbName);

        const data = JSON.stringify([{ txid: "e".repeat(64), vout: 0 }]);
        await adapter.setItem("vtxos:addr-clear", data);
        await adapter.setItem("utxos:addr-clear", data);
        await adapter.setItem(
            "tx:addr-clear",
            JSON.stringify([{ key: "tx-hash", amount: 1 }])
        );
        await adapter.setItem("wallet:state", JSON.stringify({ foo: "bar" }));
        await adapter.setItem("contract:contractA:entry", "value");
        await adapter.setItem("misc:key", "value");

        await adapter.clear();

        const storesToCheck: Array<[string, number]> = [
            ["vtxos", 0],
            ["utxos", 0],
            ["transactions", 0],
            ["walletState", 0],
            ["contractData", 0],
            ["storage", 0],
        ];

        for (const [storeName, expectedLength] of storesToCheck) {
            const records = await readStoreRecords<any>(dbName, storeName);
            expect(records).toHaveLength(expectedLength);
        }

        await cleanup(dbName);
    });
});
