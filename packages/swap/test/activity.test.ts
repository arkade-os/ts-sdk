import { describe, it, expect } from "vitest";
import { buildActivities, type ArkTransaction } from "@arkade-os/sdk";
import { swapActivityResolver, type SwapActivityInput } from "../src/activity";

const tx = (arkTxid: string, type: "SENT" | "RECEIVED", amount: number): ArkTransaction =>
    ({
        key: { arkTxid, boardingTxid: "", commitmentTxid: "" },
        type,
        amount,
        settled: true,
        createdAt: 1,
    }) as unknown as ArkTransaction;

const resolverFor = (swaps: SwapActivityInput[]) =>
    swapActivityResolver({ listSwaps: async () => swaps });

describe("swapActivityResolver", () => {
    it("groups a swap's funding and refund into one activity", async () => {
        const swaps: SwapActivityInput[] = [
            {
                rfqId: "r1",
                kind: "lightning_send",
                state: "refunded",
                txids: ["fund", "refund"],
            },
        ];

        const activities = await buildActivities(
            [tx("fund", "SENT", 1000), tx("refund", "RECEIVED", 1000)],
            [resolverFor(swaps)],
        );

        expect(activities).toHaveLength(1);
        expect(activities[0].id).toBe("swap:r1");
        expect(activities[0].txs).toHaveLength(2);
    });

    it("reports the swap's state as the activity status", async () => {
        const swaps: SwapActivityInput[] = [
            { rfqId: "r1", kind: "lightning_send", state: "failed", txids: ["fund"] },
        ];

        const [activity] = await buildActivities([tx("fund", "SENT", 1000)], [resolverFor(swaps)]);

        expect(activity.intent?.status).toBe("Failed");
        expect(activity.intent?.kind).toBe("swap");
    });

    it("labels each leg by its corridor", async () => {
        const send: SwapActivityInput[] = [
            { rfqId: "r1", kind: "lightning_send", state: "settled", txids: ["a"] },
        ];
        const receive: SwapActivityInput[] = [
            { rfqId: "r2", kind: "lightning_receive", state: "settled", txids: ["b"] },
        ];

        const [sent] = await buildActivities([tx("a", "SENT", 1)], [resolverFor(send)]);
        const [received] = await buildActivities([tx("b", "RECEIVED", 1)], [resolverFor(receive)]);

        expect(sent.intent?.label).toBe("Lightning send");
        expect(received.intent?.label).toBe("Lightning receive");
    });

    it("leaves an unrelated transaction plain", async () => {
        const swaps: SwapActivityInput[] = [
            { rfqId: "r1", kind: "lightning_send", state: "pending", txids: ["fund"] },
        ];

        const activities = await buildActivities([tx("other", "SENT", 500)], [resolverFor(swaps)]);

        expect(activities[0].id).toBe("other");
        expect(activities[0].intent).toBeUndefined();
    });

    it("contributes nothing when the record read rejects", async () => {
        const resolver = swapActivityResolver({
            listSwaps: async () => {
                throw new Error("store unavailable");
            },
        });

        const activities = await buildActivities([tx("fund", "SENT", 1000)], [resolver]);

        // buildActivities isolates a resolver whose prepare() rejects; history
        // must still render rather than failing whole.
        expect(activities).toHaveLength(1);
        expect(activities[0].intent).toBeUndefined();
    });

    it("ignores a swap with no transactions yet", async () => {
        const swaps: SwapActivityInput[] = [
            { rfqId: "r1", kind: "lightning_send", state: "pending", txids: [] },
        ];

        const activities = await buildActivities([tx("other", "SENT", 1)], [resolverFor(swaps)]);

        expect(activities).toHaveLength(1);
        expect(activities[0].id).toBe("other");
    });
});
