/**
 * Run `fn` under a **queueing** exclusive Web Lock when the runtime
 * provides one (browser main thread, service worker), so same-origin
 * contexts sharing persistent storage take turns instead of racing. In
 * environments without `navigator.locks` (Node, React Native) the
 * callback runs immediately with no coordination — there, a single
 * process owns the storage and in-process serialization suffices.
 *
 * Unlike the skip-if-held lock used by the wallet's poll loops, this
 * variant queues: it is meant for writes that must happen exactly once
 * per caller and may never be silently dropped.
 *
 * Web Locks are not reentrant — never call this while already holding
 * `name`, or the request deadlocks.
 */
export async function withWebLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const locks =
        typeof globalThis !== "undefined" && typeof globalThis.navigator !== "undefined"
            ? globalThis.navigator.locks
            : undefined;
    if (!locks) return fn();
    return locks.request(name, { mode: "exclusive" }, () => fn());
}
