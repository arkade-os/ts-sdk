import { Outpoint } from "../../wallet";
import {
    ArkIntent,
    IntentPageFilter,
    IntentRepository,
    intentMatchesFilter,
    isTerminalIntentState,
} from "../intentRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";
import { awaitTransaction, promisifyRequest } from "./idbUtils";
import { createManagedConnection, ManagedConnection } from "./managedConnection";
import { DB_VERSION, initDatabase, STORE_INTENTS } from "./schema";
import { DEFAULT_DB_NAME } from "../../worker/browser/utils";

/**
 * @experimental Intent persistence is opt-in: nothing writes intents unless this
 * repository is passed to the wallet. Its stores are part of the shared wallet
 * schema, so it can share the wallet/contract DB name.
 */
export class IndexedDBIntentRepository implements IntentRepository {
    readonly version = 1 as const;
    private readonly connection: ManagedConnection;
    constructor(dbName: string = DEFAULT_DB_NAME) {
        this.connection = createManagedConnection(dbName, DB_VERSION, initDatabase);
    }

    private getDB(): Promise<IDBDatabase> {
        return this.connection.get();
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

    async getIntentsPage(
        filter: IntentPageFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<ArkIntent>> {
        assertPageRequest(page);
        const db = await this.getDB();
        const store = db.transaction([STORE_INTENTS], "readonly").objectStore(STORE_INTENTS);
        if (filter?.intentTxIds) {
            const keys = [...new Set(filter.intentTxIds)]
                .filter((id) => page.after === undefined || id > page.after)
                .sort();
            const intents = await Promise.all(
                keys.map((id) => promisifyRequest<ArkIntent | undefined>(store.get(id))),
            );
            return pageResult(
                intents.filter((i): i is ArkIntent => !!i && intentMatchesFilter(i, filter)),
                page.limit,
                (intent) => intent.intentTxId,
            );
        }
        const range =
            page.after === undefined ? undefined : IDBKeyRange.lowerBound(page.after, true);
        const request = store.openCursor(range);
        return new Promise((resolve, reject) => {
            const rows: ArkIntent[] = [];
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(pageResult(rows, page.limit, (intent) => intent.intentTxId));
                    return;
                }
                const intent = cursor.value as ArkIntent;
                if (!filter || intentMatchesFilter(intent, filter)) rows.push(intent);
                if (rows.length > page.limit) {
                    resolve(pageResult(rows, page.limit, (intent) => intent.intentTxId));
                    return;
                }
                cursor.continue();
            };
        });
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
        await this.connection[Symbol.asyncDispose]();
    }
}
