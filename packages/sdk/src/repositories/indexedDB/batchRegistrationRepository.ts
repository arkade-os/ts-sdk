import { Outpoint } from "../../wallet";
import {
    BatchRegistration,
    BatchRegistrationPageFilter,
    IntentRepository,
    registrationMatchesFilter,
    isTerminalBatchRegistrationState,
} from "../batchRegistrationRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";
import { awaitTransaction, promisifyRequest } from "./idbUtils";
import { createManagedConnection, ManagedConnection } from "./managedConnection";
import {
    BATCHES_DB_NAME,
    BATCHES_DB_VERSION,
    initBatchesDatabase,
    STORE_BATCH_REGISTRATIONS,
} from "./batchesSchema";

/** A {@link BatchRegistration} as IndexedDB holds it: the store's keyPath and index read these keys. */
type StoredRegistration = Omit<BatchRegistration, "proofTxId" | "registrationId" | "inputs"> & {
    intentTxId: string;
    intentId?: string;
    intentVtxos: Outpoint[];
};

const toStored = ({
    proofTxId,
    registrationId,
    inputs,
    ...rest
}: BatchRegistration): StoredRegistration => ({
    ...rest,
    intentTxId: proofTxId,
    intentId: registrationId,
    intentVtxos: inputs,
});

const fromStored = ({
    intentTxId,
    intentId,
    intentVtxos,
    ...rest
}: StoredRegistration): BatchRegistration => ({
    ...rest,
    proofTxId: intentTxId,
    registrationId: intentId,
    inputs: intentVtxos,
});

/**
 * @experimental Batch registration persistence is opt-in. Stored in its own database,
 * {@link BATCHES_DB_NAME} by default, never in the wallet/contract one.
 */
export class IndexedDBBatchRegistrationRepository implements IntentRepository {
    readonly version = 2 as const;
    /** @deprecated Use {@link saveRegistration}. */
    saveIntent = this.saveRegistration;
    /** @deprecated Use {@link getRegistrationsPage}. */
    getIntentsPage = this.getRegistrationsPage;
    private readonly connection: ManagedConnection;
    constructor(dbName: string = BATCHES_DB_NAME) {
        this.connection = createManagedConnection(dbName, BATCHES_DB_VERSION, initBatchesDatabase);
    }

    private getDB(): Promise<IDBDatabase> {
        return this.connection.get();
    }

    async clear(): Promise<void> {
        const db = await this.getDB();
        const transaction = db.transaction([STORE_BATCH_REGISTRATIONS], "readwrite");
        transaction.objectStore(STORE_BATCH_REGISTRATIONS).clear();
        await awaitTransaction(transaction);
    }

    async saveRegistration(registration: BatchRegistration): Promise<void> {
        const db = await this.getDB();
        const transaction = db.transaction([STORE_BATCH_REGISTRATIONS], "readwrite");
        transaction
            .objectStore(STORE_BATCH_REGISTRATIONS)
            .put(toStored({ ...registration, updatedAt: Date.now() }));
        await awaitTransaction(transaction);
    }

    async getRegistrationsPage(
        filter: BatchRegistrationPageFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<BatchRegistration>> {
        assertPageRequest(page);
        const db = await this.getDB();
        const store = db
            .transaction([STORE_BATCH_REGISTRATIONS], "readonly")
            .objectStore(STORE_BATCH_REGISTRATIONS);
        if (filter?.proofTxIds) {
            const keys = [...new Set(filter.proofTxIds)]
                .filter((id) => page.after === undefined || id > page.after)
                .sort();
            const registrations = await Promise.all(
                keys.map((id) => promisifyRequest<StoredRegistration | undefined>(store.get(id))),
            );
            return pageResult(
                registrations
                    .filter((i): i is StoredRegistration => !!i)
                    .map(fromStored)
                    .filter((i) => registrationMatchesFilter(i, filter)),
                page.limit,
                (registration) => registration.proofTxId,
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
                    resolve(pageResult(rows, page.limit, (registration) => registration.proofTxId));
                    return;
                }
                const registration = fromStored(cursor.value as StoredRegistration);
                if (!filter || registrationMatchesFilter(registration, filter))
                    rows.push(registration);
                if (rows.length > page.limit) {
                    resolve(pageResult(rows, page.limit, (registration) => registration.proofTxId));
                    return;
                }
                cursor.continue();
            };
        });
    }

    async getLockedVtxoOutpoints(): Promise<Outpoint[]> {
        const db = await this.getDB();
        const store = db
            .transaction([STORE_BATCH_REGISTRATIONS], "readonly")
            .objectStore(STORE_BATCH_REGISTRATIONS);
        const all = (await promisifyRequest(store.getAll())) as StoredRegistration[];
        const out: Outpoint[] = [];
        for (const i of all)
            if (!isTerminalBatchRegistrationState(i.state))
                for (const o of i.intentVtxos) out.push(o);
        return out;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.connection[Symbol.asyncDispose]();
    }
}

/** @deprecated Use {@link IndexedDBBatchRegistrationRepository}. */
export const IndexedDBIntentRepository = IndexedDBBatchRegistrationRepository;
/** @deprecated Use {@link IndexedDBBatchRegistrationRepository}. */
export type IndexedDBIntentRepository = IndexedDBBatchRegistrationRepository;
