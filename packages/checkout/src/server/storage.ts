// Global store that persists across API calls in the same process
// Using globalThis to ensure we get the same instance
import { debug } from "./log";

const STORE_KEY = "__checkout_store__";

function getStore(): Map<string, any> {
    if (!(globalThis as any)[STORE_KEY]) {
        debug("[storage] Initializing new checkout store");
        (globalThis as any)[STORE_KEY] = new Map<string, any>();
    }
    return (globalThis as any)[STORE_KEY];
}

export async function getCheckout(id: string): Promise<any | null> {
    if (process.env.KV_REST_API_URL) {
        const kv = require("@vercel/kv");
        const data = await kv.get(`checkout:${id}`);
        return data ? JSON.parse(data as string) : null;
    } else {
        const store = getStore();
        const key = `checkout:${id}`;
        const data = store.get(key);
        debug("[storage] Getting checkout:", id, "found:", !!data, "status:", data?.status);
        return data || null;
    }
}

export async function setCheckout(id: string, data: any): Promise<void> {
    debug("[storage] Setting checkout:", id, "status:", data.status);
    if (process.env.KV_REST_API_URL) {
        const kv = require("@vercel/kv");
        await kv.set(`checkout:${id}`, JSON.stringify(data), { ex: 3600 });
    } else {
        const store = getStore();
        const key = `checkout:${id}`;
        store.set(key, data);
        debug("[storage] Store size:", store.size, "keys:", Array.from(store.keys()));
    }
}

export async function updateCheckout(id: string, updates: any): Promise<void> {
    debug("[storage] Updating checkout:", id, "with:", updates);
    const checkout = await getCheckout(id);
    if (!checkout) {
        console.error("[storage] Cannot update, checkout not found:", id);
        debug(
            "[storage] Store contents:",
            Array.from(getStore().entries()).map(([k, v]) => `${k}: ${v?.status}`),
        );
        return;
    }
    const updated = { ...checkout, ...updates };
    await setCheckout(id, updated);
    debug("[storage] Updated checkout:", id, "new status:", updated.status);
}
