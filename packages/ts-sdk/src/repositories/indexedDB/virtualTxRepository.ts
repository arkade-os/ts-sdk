import { Outpoint } from "../../wallet";
import { ChainedTxType, VirtualTx, VirtualTxRepository, VtxoBranch } from "../virtualTxRepository";
import { awaitTransaction, promisifyRequest } from "./idbUtils";
import { closeDatabase, openDatabase } from "./manager";
import { initDatabase, DB_VERSION, STORE_VIRTUAL_TXS, STORE_VTXO_BRANCHES } from "./schema";
import { DEFAULT_DB_NAME } from "../../worker/browser/utils";

export class IndexedDBVirtualTxRepository implements VirtualTxRepository {
    readonly version = 1 as const;
    private db: IDBDatabase | null = null;
    constructor(private readonly dbName: string = DEFAULT_DB_NAME) {}

    private async getDB(): Promise<IDBDatabase> {
        if (!this.db) this.db = await openDatabase(this.dbName, DB_VERSION, initDatabase);
        return this.db;
    }

    async clear(): Promise<void> {
        const db = await this.getDB();
        const transaction = db.transaction([STORE_VIRTUAL_TXS, STORE_VTXO_BRANCHES], "readwrite");
        transaction.objectStore(STORE_VIRTUAL_TXS).clear();
        transaction.objectStore(STORE_VTXO_BRANCHES).clear();
        await awaitTransaction(transaction);
    }

    async upsertVirtualTxs(txs: VirtualTx[]): Promise<void> {
        if (txs.length === 0) return;
        const db = await this.getDB();
        // Read-modify-write in ONE transaction: each merged put is issued from
        // its get's onsuccess, so the transaction stays live (never crossing an
        // await boundary) and a concurrent writer can't slip between read and
        // write. new value wins, else the stored value is preserved.
        const transaction = db.transaction([STORE_VIRTUAL_TXS], "readwrite");
        const store = transaction.objectStore(STORE_VIRTUAL_TXS);
        for (const tx of txs) {
            const getReq = store.get(tx.txid);
            getReq.onsuccess = () => {
                const prev = getReq.result as VirtualTx | undefined;
                store.put({
                    txid: tx.txid,
                    hex: tx.hex ?? prev?.hex ?? null,
                    expiresAt: tx.expiresAt ?? prev?.expiresAt ?? null,
                    type: tx.type ?? prev?.type ?? ChainedTxType.Unspecified,
                } satisfies VirtualTx);
            };
        }
        await awaitTransaction(transaction);
    }

    async getVirtualTx(txid: string): Promise<VirtualTx | null> {
        const db = await this.getDB();
        const store = db
            .transaction([STORE_VIRTUAL_TXS], "readonly")
            .objectStore(STORE_VIRTUAL_TXS);
        const r = (await promisifyRequest(store.get(txid))) as VirtualTx | undefined;
        return r ?? null;
    }

    async setBranch(vtxo: Outpoint, branch: VtxoBranch[]): Promise<void> {
        const db = await this.getDB();
        // Replace the branch atomically: the deletes+puts are issued from the
        // getAll onsuccess, inside one readwrite transaction, so no concurrent
        // setBranch/prune can interleave with the read that drives them.
        const transaction = db.transaction([STORE_VTXO_BRANCHES], "readwrite");
        const store = transaction.objectStore(STORE_VTXO_BRANCHES);
        const getAllReq = store.index("vtxo").getAll(IDBKeyRange.only([vtxo.txid, vtxo.vout]));
        getAllReq.onsuccess = () => {
            const existing = getAllReq.result as VtxoBranch[];
            for (const e of existing) store.delete([e.vtxoTxid, e.vtxoVout, e.position]);
            for (const b of branch) store.put(b);
        };
        await awaitTransaction(transaction);
    }

    async getBranch(vtxo: Outpoint): Promise<VirtualTx[]> {
        const db = await this.getDB();
        // One transaction over both stores: batch-load every referenced tx by
        // issuing the gets from the branch getAll's onsuccess, instead of N
        // sequential getVirtualTx round trips each opening its own transaction.
        const transaction = db.transaction([STORE_VTXO_BRANCHES, STORE_VIRTUAL_TXS], "readonly");
        const branchStore = transaction.objectStore(STORE_VTXO_BRANCHES);
        const txStore = transaction.objectStore(STORE_VIRTUAL_TXS);
        const getAllReq = branchStore
            .index("vtxo")
            .getAll(IDBKeyRange.only([vtxo.txid, vtxo.vout]));
        const byTxid = new Map<string, VirtualTx>();
        let ordered: VtxoBranch[] = [];
        getAllReq.onsuccess = () => {
            ordered = (getAllReq.result as VtxoBranch[])
                .slice()
                .sort((a, b) => a.position - b.position);
            for (const b of ordered) {
                const txReq = txStore.get(b.virtualTxid);
                txReq.onsuccess = () => {
                    const r = txReq.result as VirtualTx | undefined;
                    if (r) byTxid.set(b.virtualTxid, r);
                };
            }
        };
        await awaitTransaction(transaction);
        const out: VirtualTx[] = [];
        for (const b of ordered) {
            const tx = byTxid.get(b.virtualTxid);
            if (tx) out.push(tx);
        }
        return out;
    }

    async hasBranch(vtxo: Outpoint): Promise<boolean> {
        const db = await this.getDB();
        const vtxoIndex = db
            .transaction([STORE_VTXO_BRANCHES], "readonly")
            .objectStore(STORE_VTXO_BRANCHES)
            .index("vtxo");
        const count = await promisifyRequest(
            vtxoIndex.count(IDBKeyRange.only([vtxo.txid, vtxo.vout])),
        );
        return count > 0;
    }

    async pruneForSpentVtxo(vtxo: Outpoint): Promise<void> {
        const db = await this.getDB();
        // Branch pruning + orphan sweep in ONE readwrite transaction spanning
        // both stores. Every request is issued from a prior request's
        // onsuccess, so the transaction never crosses an await boundary and no
        // concurrent setBranch can race the read/delete/recount/delete pipeline.
        // Requests execute in issue order, so the per-tx orphan count runs after
        // the branch deletes and reflects post-delete reference state.
        const transaction = db.transaction([STORE_VTXO_BRANCHES, STORE_VIRTUAL_TXS], "readwrite");
        const branches = transaction.objectStore(STORE_VTXO_BRANCHES);
        const txStore = transaction.objectStore(STORE_VIRTUAL_TXS);
        const getAllReq = branches.index("vtxo").getAll(IDBKeyRange.only([vtxo.txid, vtxo.vout]));
        getAllReq.onsuccess = () => {
            const removed = getAllReq.result as VtxoBranch[];
            if (removed.length === 0) return;
            for (const e of removed) branches.delete([e.vtxoTxid, e.vtxoVout, e.position]);
            // Orphan sweep: drop each referenced tx that no surviving branch
            // still points at (count issued after the deletes above).
            for (const e of removed) {
                const countReq = branches
                    .index("virtualTxid")
                    .count(IDBKeyRange.only(e.virtualTxid));
                countReq.onsuccess = () => {
                    if (countReq.result === 0) txStore.delete(e.virtualTxid);
                };
            }
        };
        await awaitTransaction(transaction);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.db) return;
        await closeDatabase(this.dbName);
        this.db = null;
    }
}
