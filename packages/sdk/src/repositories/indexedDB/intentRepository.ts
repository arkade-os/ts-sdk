import { Outpoint } from "../../wallet";
import {
    BatchRegistration,
    IntentPageFilter,
    IntentRepository,
    intentMatchesFilter,
    isTerminalIntentState,
} from "../intentRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";
import { awaitTransaction, promisifyRequest } from "./idbUtils";
import { createManagedConnection, ManagedConnection } from "./managedConnection";
import {
    BATCHES_DB_NAME,
    BATCHES_DB_VERSION,
    initBatchesDatabase,
    STORE_INTENTS,
} from "./batchesSchema";

/**
 * @experimental Intent persistence is opt-in. Stored in its own database,
 * {@link BATCHES_DB_NAME} by default, never in the wallet/contract one.
 */
export class IndexedDBIntentRepository implements IntentRepository {
    readonly version = 1 as const;
    private readonly connection: ManagedConnection;
    constructor(dbName: string = BATCHES_DB_NAME) {
        this.connection = createManagedConnection(dbName, BATCHES_DB_VERSION, initBatchesDatabase);
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

    async saveIntent(intent: BatchRegistration): Promise<void> {
        const db = await this.getDB();
        const transaction = db.transaction([STORE_INTENTS], "readwrite");
        transaction.objectStore(STORE_INTENTS).put({ ...intent, updatedAt: Date.now() });
        await awaitTransaction(transaction);
    }

    async getIntentsPage(
        filter: IntentPageFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<BatchRegistration>> {
        assertPageRequest(page);
        const db = await this.getDB();
        const store = db.transaction([STORE_INTENTS], "readonly").objectStore(STORE_INTENTS);
        if (filter?.intentTxIds) {
            const keys = [...new Set(filter.intentTxIds)]
                .filter((id) => page.after === undefined || id > page.after)
                .sort();
            const intents = await Promise.all(
                keys.map((id) => promisifyRequest<BatchRegistration | undefined>(store.get(id))),
            );
            return pageResult(
                intents.filter(
                    (i): i is BatchRegistration => !!i && intentMatchesFilter(i, filter),
                ),
                page.limit,
                (intent) => intent.intentTxId,
            );
        }
        const range =
            page.after === undefined ? undefined : IDBKeyRange.lowerBound(page.after, true);
        const request = store.openCursor(range);
        return new Promise((resolve, reject) => {
            const rows: BatchRegistration[] = [];
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(pageResult(rows, page.limit, (intent) => intent.intentTxId));
                    return;
                }
                const intent = cursor.value as BatchRegistration;
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
        const all = (await promisifyRequest(store.getAll())) as BatchRegistration[];
        const out: Outpoint[] = [];
        for (const i of all)
            if (!isTerminalIntentState(i.state)) for (const o of i.intentVtxos) out.push(o);
        return out;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.connection[Symbol.asyncDispose]();
    }
}
