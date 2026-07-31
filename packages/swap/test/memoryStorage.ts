import type { SwapStorage } from "../src/markets";

/** In-memory SwapStorage with the backing map exposed for assertions. */
export const memoryStorage = (): SwapStorage & { map: Map<string, string> } => {
    const map = new Map<string, string>();
    return {
        map,
        get: (key) => map.get(key) ?? null,
        set: (key, value) => void map.set(key, value),
    };
};
