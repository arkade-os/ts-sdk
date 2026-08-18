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
    it("resolves a swap's transaction to its groupId, label, outcome and metadata", async () => {
        const resolver = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "settled", txids: ["fund"] },
        ]);

        expect(resolver.resolve(tx("fund"))).toEqual([
            {
                groupId: "swap:r1",
                label: "Lightning send",
                kind: "swap",
                outcome: "settled",
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

    it("reports the swap's state as the membership outcome", async () => {
        const resolver = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "failed", txids: ["fund"] },
        ]);

        expect(resolver.resolve(tx("fund"))).toEqual([
            expect.objectContaining({ outcome: "failed", kind: "swap" }),
        ]);
    });

    it("gives a lightning_receive refund a different outcome than a lightning_send refund", async () => {
        // RfqSwapState's `refunded` case (swapManager.ts): a send-leg refund is
        // money coming back, but a receive-leg refund is a LOSS — the trader's
        // incoming payment never arrived. The two must not render as the same
        // token.
        const send = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "refunded", txids: ["a"] },
        ]);
        const receive = await preparedResolver([
            { rfqId: "r2", kind: "lightning_receive", state: "refunded", txids: ["b"] },
        ]);

        const sendOutcome = send.resolve(tx("a"))?.[0].outcome;
        const receiveOutcome = receive.resolve(tx("b"))?.[0].outcome;

        expect(sendOutcome).toBe("refunded");
        expect(receiveOutcome).toBe("lost");
        expect(receiveOutcome).not.toBe(sendOutcome);
    });

    it("labels each leg by its corridor", async () => {
        const send = await preparedResolver([
            { rfqId: "r1", kind: "lightning_send", state: "settled", txids: ["a"] },
        ]);
        const receive = await preparedResolver([
            { rfqId: "r2", kind: "lightning_receive", state: "settled", txids: ["b"] },
        ]);
        const onchainSend = await preparedResolver([
            { rfqId: "r3", kind: "onchain_send", state: "settled", txids: ["c"] },
        ]);

        expect(send.resolve(tx("a"))).toEqual([
            expect.objectContaining({ label: "Lightning send" }),
        ]);
        expect(receive.resolve(tx("b"))).toEqual([
            expect.objectContaining({ label: "Lightning receive" }),
        ]);
        expect(onchainSend.resolve(tx("c"))).toEqual([
            expect.objectContaining({ label: "Onchain send" }),
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
