/** Minimal synchronous key-value cache the markets layer persists into. Only
 * refetchable cache data lives here (durable swap records go through
 * AssetSwapRepository); any backend works: web storage, an in-memory Map,
 * MMKV, … the caller owns the instance and its lifetime.
 * ponytail: no remove(); nothing here deletes keys — add it when a consumer
 * needs deletion. */
export interface SwapStorage {
    get(key: string): string | null;
    set(key: string, value: string): void;
}

/** Read + parse a stored value; any failure (missing key, backend throw,
 * parser throw) yields the fallback so corrupt storage never breaks a read. */
export const getStorageItem = <T>(
    storage: SwapStorage,
    key: string,
    fallback: T,
    parser: (val: string) => T,
): T => {
    try {
        const item = storage.get(key);
        return item !== null ? parser(item) : fallback;
    } catch {
        return fallback;
    }
};

/** For non-critical persistence where a failed write (quota, private mode)
 * should degrade silently rather than fail the caller. */
export const setStorageItemSafely = (storage: SwapStorage, key: string, value: string): void => {
    try {
        storage.set(key, value);
    } catch {
        // best effort: a lost cache write just means a refetch
    }
};
