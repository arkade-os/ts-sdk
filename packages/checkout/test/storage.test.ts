import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCheckout, setCheckout, updateCheckout } from "../src/server/storage";

const ID = "checkout-race";

beforeEach(() => {
    delete (globalThis as any).__checkout_store__;
    delete (globalThis as any).__checkout_locks__;
    vi.restoreAllMocks();
});

describe("updateCheckout serializes concurrent read-modify-write", () => {
    it("keeps both fields when two handlers update at once", async () => {
        await setCheckout(ID, { id: ID, status: "pending" });
        await Promise.all([
            updateCheckout(ID, { txid: "abc" }),
            updateCheckout(ID, { status: "paid" }),
        ]);
        expect(await getCheckout(ID)).toEqual({
            id: ID,
            status: "paid",
            txid: "abc",
        });
    });

    it("applies ten concurrent updates without dropping one", async () => {
        await setCheckout(ID, { id: ID });
        const keys = Array.from({ length: 10 }, (_, i) => `f${i}`);
        await Promise.all(keys.map((k) => updateCheckout(ID, { [k]: k })));
        const stored = await getCheckout(ID);
        for (const k of keys) expect(stored[k]).toBe(k);
    });

    it("does not strand later updates on the same id when one throws", async () => {
        await setCheckout(ID, { id: ID });
        // A missing checkout returns early; failing the READ is the only reject.
        class FailsOnceStore extends Map<string, any> {
            poisoned = true;
            get(key: string) {
                if (this.poisoned) {
                    this.poisoned = false;
                    throw new Error("store unavailable");
                }
                return super.get(key);
            }
        }
        const real = (globalThis as any).__checkout_store__ as Map<string, any>;
        (globalThis as any).__checkout_store__ = new FailsOnceStore(real);

        const failing = updateCheckout(ID, { a: 1 });
        const after = updateCheckout(ID, { b: 2 });
        await expect(failing).rejects.toThrow(/store unavailable/);
        await after;
        expect((await getCheckout(ID)).b).toBe(2);
    });
});
