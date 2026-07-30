// Shared promise adapters for the raw IndexedDB API, used across the
// IndexedDB-backed repositories in this directory.

/** Resolve with an {@link IDBRequest}'s result, or reject with its error. */
export const promisifyRequest = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

/** Resolve once a transaction commits, or reject if it errors or aborts. */
export const awaitTransaction = (transaction: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("transaction aborted"));
    });
