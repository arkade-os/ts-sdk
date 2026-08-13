import { describe, it, expect } from "vitest";
import type { ArkTransaction } from "@arkade-os/sdk";
import { swapActivityResolver, type SwapActivityInput } from "../src/activity";

const tx = (arkTxid: string): ArkTransaction =>
    ({
        key: { arkTxid, boardingTxid: "", commitmentTxid: "" },
        type: "SENT",
        amount: 1000,
        settled: true,
        createdAt: 1,
    }) as unknown as ArkTransaction;

/** Builds a resolver and runs prepare() — resolve() only sees data after this. */
const preparedResolver = async (swaps: SwapActivityInput[]) => {
    const resolver = swapActivityResolver({ listSwaps: async () => swaps });
    await resolver.prepare!();
    return resolver;
};

describe("swapActivityResolver", () => {
    it("resolves a swap's transaction to its groupId, label, status and metadata", async () => {
        const resolver = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "settled", txids: ["fund"] },
        ]);

        expect(resolver.resolve(tx("fund"))).toEqual([
            {
                groupId: "swap:r1",
                label: "Lightning send",
                kind: "swap",
                status: "Settled",
                metadata: { rfqId: "r1", swapKind: "lightning_send" },
            },
        ]);
    });

    it("indexes every txid of a swap to the same groupId", async () => {
        const resolver = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "refunded", txids: ["fund", "refund"] },
        ]);

        const funding = resolver.resolve(tx("fund"));
        const refund = resolver.resolve(tx("refund"));

        expect(funding?.[0].groupId).toBe("swap:r1");
        expect(refund?.[0].groupId).toBe(funding?.[0].groupId);
    });

    it("reports the swap's state as the membership status", async () => {
        const resolver = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "failed", txids: ["fund"] },
        ]);

        expect(resolver.resolve(tx("fund"))).toEqual([
            expect.objectContaining({ status: "Failed", kind: "swap" }),
        ]);
    });

    it("labels each leg by its corridor", async () => {
        const send = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "settled", txids: ["a"] },
        ]);
        const receive = await preparedResolver([
            { rfqId: "r2", kind: "lightning_receive", state: "settled", txids: ["b"] },
        ]);

        expect(send.resolve(tx("a"))).toEqual([
            expect.objectContaining({ label: "Lightning send" }),
        ]);
        expect(receive.resolve(tx("b"))).toEqual([
            expect.objectContaining({ label: "Lightning receive" }),
        ]);
    });

    it("leaves an unrelated transaction plain", async () => {
        const resolver = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "pending", txids: ["fund"] },
        ]);

        expect(resolver.resolve(tx("other"))).toBeUndefined();
    });

    it("leaves the index empty when listSwaps rejects, so resolve contributes nothing", async () => {
        const resolver = swapActivityResolver({
            listSwaps: async () => {
                throw new Error("store unavailable");
            },
        });

        await expect(resolver.prepare!()).rejects.toThrow("store unavailable");
        expect(resolver.resolve(tx("fund"))).toBeUndefined();
    });

    it("a swap with no transactions yet contributes nothing", async () => {
        const resolver = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "pending", txids: [] },
        ]);

        expect(resolver.resolve(tx("other"))).toBeUndefined();
    });

    it("resolve() before prepare() returns undefined rather than throwing", () => {
        const resolver = swapActivityResolver({ listSwaps: async () => [] });

        expect(resolver.resolve(tx("fund"))).toBeUndefined();
    });
});
