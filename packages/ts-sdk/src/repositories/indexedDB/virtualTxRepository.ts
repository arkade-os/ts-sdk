import { Outpoint } from "../../wallet";
import {
    ChainedTxType,
    VirtualTx,
    VirtualTxRepository,
    VtxoBranch,
} from "../virtualTxRepository";
import { closeDatabase, openDatabase } from "./manager";
import {
    initDatabase,
    DB_VERSION,
    STORE_VIRTUAL_TXS,
    STORE_VTXO_BRANCHES,
} from "./schema";
import { DEFAULT_DB_NAME } from "../../worker/browser/utils";

const req = <T>(r: IDBRequest<T>): Promise<T> =>
    new Promise((res, rej) => {
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });

const done = (t: IDBTransaction): Promise<void> =>
    new Promise((res, rej) => {
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
        t.onabort = () => rej(t.error ?? new Error("transaction aborted"));
    });

export class IndexedDBVirtualTxRepository implements VirtualTxRepository {
    readonly version = 1 as const;
    private db: IDBDatabase | null = null;
    constructor(private readonly dbName: string = DEFAULT_DB_NAME) {}

    private async getDB(): Promise<IDBDatabase> {
        if (!this.db)
            this.db = await openDatabase(this.dbName, DB_VERSION, initDatabase);
        return this.db;
    }

    async clear(): Promise<void> {
        const db = await this.getDB();
        const t = db.transaction(
            [STORE_VIRTUAL_TXS, STORE_VTXO_BRANCHES],
            "readwrite"
        );
        t.objectStore(STORE_VIRTUAL_TXS).clear();
        t.objectStore(STORE_VTXO_BRANCHES).clear();
        await done(t);
    }

    async upsertVirtualTxs(txs: VirtualTx[]): Promise<void> {
        if (txs.length === 0) return;
        const db = await this.getDB();
        // Read existing rows (all gets queued synchronously, then awaited).
        const rt = db.transaction([STORE_VIRTUAL_TXS], "readonly");
        const rs = rt.objectStore(STORE_VIRTUAL_TXS);
        const prevs = await Promise.all(
            txs.map(
                (t) => req(rs.get(t.txid)) as Promise<VirtualTx | undefined>
            )
        );
        // Write merged rows (all puts queued synchronously).
        const wt = db.transaction([STORE_VIRTUAL_TXS], "readwrite");
        const ws = wt.objectStore(STORE_VIRTUAL_TXS);
        txs.forEach((t, i) => {
            const prev = prevs[i];
            ws.put({
                txid: t.txid,
                hex: t.hex ?? prev?.hex ?? null,
                expiresAt: t.expiresAt ?? prev?.expiresAt ?? null,
                type: t.type ?? prev?.type ?? ChainedTxType.Unspecified,
            } satisfies VirtualTx);
        });
        await done(wt);
    }

    async getVirtualTx(txid: string): Promise<VirtualTx | null> {
        const db = await this.getDB();
        const s = db
            .transaction([STORE_VIRTUAL_TXS], "readonly")
            .objectStore(STORE_VIRTUAL_TXS);
        const r = (await req(s.get(txid))) as VirtualTx | undefined;
        return r ?? null;
    }

    async setBranch(vtxo: Outpoint, branch: VtxoBranch[]): Promise<void> {
        const db = await this.getDB();
        const rt = db.transaction([STORE_VTXO_BRANCHES], "readonly");
        const existing = (await req(
            rt
                .objectStore(STORE_VTXO_BRANCHES)
                .index("vtxo")
                .getAll(IDBKeyRange.only([vtxo.txid, vtxo.vout]))
        )) as VtxoBranch[];
        const wt = db.transaction([STORE_VTXO_BRANCHES], "readwrite");
        const ws = wt.objectStore(STORE_VTXO_BRANCHES);
        for (const e of existing)
            ws.delete([e.vtxoTxid, e.vtxoVout, e.position]);
        for (const b of branch) ws.put(b);
        await done(wt);
    }

    async getBranch(vtxo: Outpoint): Promise<VirtualTx[]> {
        const db = await this.getDB();
        const rt = db.transaction([STORE_VTXO_BRANCHES], "readonly");
        const branchRows = (await req(
            rt
                .objectStore(STORE_VTXO_BRANCHES)
                .index("vtxo")
                .getAll(IDBKeyRange.only([vtxo.txid, vtxo.vout]))
        )) as VtxoBranch[];
        branchRows.sort((a, b) => a.position - b.position);
        const out: VirtualTx[] = [];
        for (const b of branchRows) {
            const tx = await this.getVirtualTx(b.virtualTxid);
            if (tx) out.push(tx);
        }
        return out;
    }

    async hasBranch(vtxo: Outpoint): Promise<boolean> {
        const db = await this.getDB();
        const s = db
            .transaction([STORE_VTXO_BRANCHES], "readonly")
            .objectStore(STORE_VTXO_BRANCHES)
            .index("vtxo");
        const c = await req(s.count(IDBKeyRange.only([vtxo.txid, vtxo.vout])));
        return c > 0;
    }

    async pruneForSpentVtxo(vtxo: Outpoint): Promise<void> {
        const db = await this.getDB();
        const rt = db.transaction([STORE_VTXO_BRANCHES], "readonly");
        const removed = (await req(
            rt
                .objectStore(STORE_VTXO_BRANCHES)
                .index("vtxo")
                .getAll(IDBKeyRange.only([vtxo.txid, vtxo.vout]))
        )) as VtxoBranch[];
        if (removed.length === 0) return;

        const dt = db.transaction([STORE_VTXO_BRANCHES], "readwrite");
        const ds = dt.objectStore(STORE_VTXO_BRANCHES);
        for (const e of removed)
            ds.delete([e.vtxoTxid, e.vtxoVout, e.position]);
        await done(dt);

        // Orphan sweep: a VirtualTx with no remaining branch reference is
        // deleted. Counts read first, then deletes queued — never partial.
        const ct = db.transaction([STORE_VTXO_BRANCHES], "readonly");
        const cs = ct.objectStore(STORE_VTXO_BRANCHES).index("virtualTxid");
        const stillRef = await Promise.all(
            removed.map((e) => req(cs.count(IDBKeyRange.only(e.virtualTxid))))
        );
        const orphans = removed
            .filter((_, i) => stillRef[i] === 0)
            .map((e) => e.virtualTxid);
        if (orphans.length === 0) return;
        const xt = db.transaction([STORE_VIRTUAL_TXS], "readwrite");
        const xs = xt.objectStore(STORE_VIRTUAL_TXS);
        for (const id of orphans) xs.delete(id);
        await done(xt);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.db) return;
        await closeDatabase(this.dbName);
        this.db = null;
    }
}
