import { Outpoint } from "../../wallet";
import {
    ArkIntent,
    IntentFilter,
    IntentRepository,
    intentMatchesFilter,
    intentPageBounds,
    isTerminalIntentState,
} from "../intentRepository";
import { awaitTransaction, promisifyRequest } from "./idbUtils";
import { closeDatabase, openDatabase } from "./manager";
import { initDatabase, DB_VERSION, STORE_INTENTS } from "./schema";
import { DEFAULT_DB_NAME } from "../../worker/browser/utils";

export class IndexedDBIntentRepository implements IntentRepository {
    readonly version = 1 as const;
    private db: IDBDatabase | null = null;
    constructor(private readonly dbName: string = DEFAULT_DB_NAME) {}

    private async getDB(): Promise<IDBDatabase> {
        if (!this.db) this.db = await openDatabase(this.dbName, DB_VERSION, initDatabase);
        return this.db;
    }

    async clear(): Promise<void> {
        const db = await this.getDB();
        const transaction = db.transaction([STORE_INTENTS], "readwrite");
        transaction.objectStore(STORE_INTENTS).clear();
        await awaitTransaction(transaction);
    }

    async saveIntent(intent: ArkIntent): Promise<void> {
        const db = await this.getDB();
        const transaction = db.transaction([STORE_INTENTS], "readwrite");
        transaction.objectStore(STORE_INTENTS).put({ ...intent, updatedAt: Date.now() });
        await awaitTransaction(transaction);
    }

    async getIntents(filter?: IntentFilter): Promise<ArkIntent[]> {
        const db = await this.getDB();
        const store = db.transaction([STORE_INTENTS], "readonly").objectStore(STORE_INTENTS);
        const all = (await promisifyRequest(store.getAll())) as ArkIntent[];
        all.sort((a, b) => a.createdAt - b.createdAt || a.intentTxId.localeCompare(b.intentTxId));
        const out = filter ? all.filter((i) => intentMatchesFilter(i, filter)) : all;
        const { skip, end } = intentPageBounds(filter, out.length);
        return out.slice(skip, end);
    }

    async getLockedVtxoOutpoints(): Promise<Outpoint[]> {
        const db = await this.getDB();
        const store = db.transaction([STORE_INTENTS], "readonly").objectStore(STORE_INTENTS);
        const all = (await promisifyRequest(store.getAll())) as ArkIntent[];
        const out: Outpoint[] = [];
        for (const i of all)
            if (!isTerminalIntentState(i.state)) for (const o of i.intentVtxos) out.push(o);
        return out;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        if (!this.db) return;
        await closeDatabase(this.dbName);
        this.db = null;
    }
}
