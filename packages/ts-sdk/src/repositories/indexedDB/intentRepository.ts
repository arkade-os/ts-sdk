import { Outpoint } from "../../wallet";
import {
    ArkIntent,
    IntentFilter,
    IntentRepository,
    isTerminalIntentState,
} from "../intentRepository";
import { matches } from "../inMemory/intentRepository";
import { closeDatabase, openDatabase } from "./manager";
import { initDatabase, DB_VERSION, STORE_INTENTS } from "./schema";
import { DEFAULT_DB_NAME } from "../../worker/browser/utils";

type StoredIntent = ArkIntent & { intentVtxoKeys: string[] };

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

const toStored = (i: ArkIntent): StoredIntent => ({
    ...i,
    intentVtxoKeys: i.intentVtxos.map((o) => `${o.txid}:${o.vout}`),
});
const fromStored = (s: StoredIntent): ArkIntent => {
    const { intentVtxoKeys: _drop, ...rest } = s;
    void _drop;
    return rest;
};

export class IndexedDBIntentRepository implements IntentRepository {
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
        const t = db.transaction([STORE_INTENTS], "readwrite");
        t.objectStore(STORE_INTENTS).clear();
        await done(t);
    }

    async saveIntent(intent: ArkIntent): Promise<void> {
        const db = await this.getDB();
        const t = db.transaction([STORE_INTENTS], "readwrite");
        t.objectStore(STORE_INTENTS).put(
            toStored({ ...intent, updatedAt: Date.now() })
        );
        await done(t);
    }

    async getIntents(filter?: IntentFilter): Promise<ArkIntent[]> {
        const db = await this.getDB();
        const s = db
            .transaction([STORE_INTENTS], "readonly")
            .objectStore(STORE_INTENTS);
        const all = ((await req(s.getAll())) as StoredIntent[]).map(fromStored);
        all.sort(
            (a, b) =>
                a.createdAt - b.createdAt ||
                a.intentTxId.localeCompare(b.intentTxId)
        );
        const out = filter ? all.filter((i) => matches(i, filter)) : all;
        const skip = filter?.skip ?? 0;
        const take = filter?.take ?? out.length;
        return out.slice(skip, skip + take);
    }

    async getLockedVtxoOutpoints(): Promise<Outpoint[]> {
        const db = await this.getDB();
        const s = db
            .transaction([STORE_INTENTS], "readonly")
            .objectStore(STORE_INTENTS);
        const all = (await req(s.getAll())) as StoredIntent[];
        const out: Outpoint[] = [];
        for (const i of all)
            if (!isTerminalIntentState(i.state))
                for (const o of i.intentVtxos) out.push(o);
        return out;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.db) return;
        await closeDatabase(this.dbName);
        this.db = null;
    }
}
