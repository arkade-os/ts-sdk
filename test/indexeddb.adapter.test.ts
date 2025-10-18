import "fake-indexeddb/auto";
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

        const db = await (adapter as any).getDB();
        const tx = db.transaction(["vtxos"], "readonly");
        const store = tx.objectStore("vtxos");
        const records = await getAllRecords<any>(store);
        await waitForTransaction(tx);

        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({
            address: "addr1",
            txid: payload[0].txid,
            vout: payload[0].vout,
            order: 0,
        });

        db.close();
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

        const db = await (adapter as any).getDB();
        const tx = db.transaction(["vtxos"], "readonly");
        const store = tx.objectStore("vtxos");
        const records = await getAllRecords<any>(store);
        await waitForTransaction(tx);

        expect(records).toHaveLength(1);
        expect(records[0].address).toBe("addrB");

        db.close();
        await cleanup(dbName);
    });

    it("migrates legacy fallback data on first read", async () => {
        const dbName = randomDbName();
        const adapter = new IndexedDBStorageAdapter(dbName);
        const key = "tx:addr-migrate";
        const payload = [{ key: "tx-key-1", amount: 1 }];

        const db = await (adapter as any).getDB();
        const fallbackTx = db.transaction(["storage"], "readwrite");
        fallbackTx.objectStore("storage").put(JSON.stringify(payload), key);
        await waitForTransaction(fallbackTx);

        const result = await adapter.getItem(key);
        expect(result).toEqual(JSON.stringify(payload));

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

        db.close();
        await cleanup(dbName);
    });
});
