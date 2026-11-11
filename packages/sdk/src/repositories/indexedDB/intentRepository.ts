import { Outpoint } from "../../wallet";
import {
    BatchRegistration,
    BatchRegistrationPageFilter,
    BatchRegistrationRepository,
    intentMatchesFilter,
    isTerminalBatchRegistrationState,
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

/** A {@link BatchRegistration} as IndexedDB holds it: the store's keyPath and index read these names. */
type StoredIntent = Omit<BatchRegistration, "proofTxId" | "registrationId" | "proofInputs"> & {
    intentTxId: string;
    intentId?: string;
    intentVtxos: Outpoint[];
};

const toStored = ({
    proofTxId,
    registrationId,
    proofInputs,
    ...rest
}: BatchRegistration): StoredIntent => ({
    ...rest,
    intentTxId: proofTxId,
    intentId: registrationId,
    intentVtxos: proofInputs,
});

const fromStored = ({
    intentTxId,
    intentId,
    intentVtxos,
    ...rest
}: StoredIntent): BatchRegistration => ({
    ...rest,
    proofTxId: intentTxId,
    registrationId: intentId,
    proofInputs: intentVtxos,
});

/**
 * @experimental Batch registration persistence is opt-in. Stored in its own
 * database, {@link BATCHES_DB_NAME} by default, never in the wallet/contract one.
 */
export class IndexedDBBatchRegistrationRepository implements BatchRegistrationRepository {
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

    async saveBatchRegistration(intent: BatchRegistration): Promise<void> {
        const db = await this.getDB();
        const transaction = db.transaction([STORE_INTENTS], "readwrite");
        transaction.objectStore(STORE_INTENTS).put(toStored({ ...intent, updatedAt: Date.now() }));
        await awaitTransaction(transaction);
    }

    async getBatchRegistrationsPage(
        filter: BatchRegistrationPageFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<BatchRegistration>> {
        assertPageRequest(page);
        const db = await this.getDB();
        const store = db.transaction([STORE_INTENTS], "readonly").objectStore(STORE_INTENTS);
        if (filter?.proofTxIds) {
            const keys = [...new Set(filter.proofTxIds)]
                .filter((id) => page.after === undefined || id > page.after)
                .sort();
            const intents = await Promise.all(
                keys.map((id) => promisifyRequest<StoredIntent | undefined>(store.get(id))),
            );
            return pageResult(
                intents
                    .map((i) => i && fromStored(i))
                    .filter((i): i is BatchRegistration => !!i && intentMatchesFilter(i, filter)),
                page.limit,
                (intent) => intent.proofTxId,
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
                    resolve(pageResult(rows, page.limit, (intent) => intent.proofTxId));
                    return;
                }
                const intent = fromStored(cursor.value as StoredIntent);
                if (!filter || intentMatchesFilter(intent, filter)) rows.push(intent);
                if (rows.length > page.limit) {
                    resolve(pageResult(rows, page.limit, (intent) => intent.proofTxId));
                    return;
                }
                cursor.continue();
            };
        });
    }

    async getLockedVtxoOutpoints(): Promise<Outpoint[]> {
        const db = await this.getDB();
        const store = db.transaction([STORE_INTENTS], "readonly").objectStore(STORE_INTENTS);
        const all = (await promisifyRequest(store.getAll())) as StoredIntent[];
        const out: Outpoint[] = [];
        for (const i of all)
            if (!isTerminalBatchRegistrationState(i.state))
                for (const o of i.intentVtxos) out.push(o);
        return out;
    }

    /** @deprecated Use {@link saveBatchRegistration}. */
    saveIntent(intent: BatchRegistration) {
        return this.saveBatchRegistration(intent);
    }

    /** @deprecated Use {@link getBatchRegistrationsPage}. */
    getIntentsPage(filter: BatchRegistrationPageFilter | undefined, page: PageRequest) {
        return this.getBatchRegistrationsPage(filter, page);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.connection[Symbol.asyncDispose]();
    }
}

/** @deprecated Use {@link IndexedDBBatchRegistrationRepository}. */
export const IndexedDBIntentRepository = IndexedDBBatchRegistrationRepository;
/** @deprecated Use {@link IndexedDBBatchRegistrationRepository}. */
export type IndexedDBIntentRepository = IndexedDBBatchRegistrationRepository;
