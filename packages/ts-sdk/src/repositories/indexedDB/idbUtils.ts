// Shared promise adapters for the raw IndexedDB API. Used by every
// IndexedDB-backed repository in the SDK, and re-exported from the package root
// so plugin packages build on these rather than re-deriving the request and
// commit semantics per repository.

/** Resolve with an {@link IDBRequest}'s result, or reject with its error. */
export const promisifyRequest = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

/**
 * Resolve once a transaction commits, or reject if it errors or aborts.
 *
 * A write is durable at *commit*, not at request success — quota pressure and
 * storage eviction abort a transaction whose every request already succeeded.
 * Reads may resolve on {@link promisifyRequest}; writes must await this.
 */
export const awaitTransaction = (transaction: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("transaction aborted"));
    });

/**
 * Queue a delete for every row an index matches. Fire-and-forget by design:
 * the requests are queued as the cursor walks and the caller learns they
 * committed by awaiting the transaction, not this. A failing cursor or delete
 * aborts the transaction, which {@link awaitTransaction} reports.
 */
export const deleteByIndex = (
    store: IDBObjectStore,
    indexName: string,
    value: IDBValidKey,
): void => {
    const request = store.index(indexName).openCursor(IDBKeyRange.only(value));
    request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
    };
};

/** Read every row matching any of `values` on an index, flattened. */
export const getAllByIndexValues = <T>(
    store: IDBObjectStore,
    indexName: string,
    values: readonly IDBValidKey[],
): Promise<T[]> => {
    if (values.length === 0) return Promise.resolve([]);
    const index = store.index(indexName);
    return Promise.all(values.map((value) => promisifyRequest<T[]>(index.getAll(value)))).then(
        (results) => results.flat(),
    );
};
