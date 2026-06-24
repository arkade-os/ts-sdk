import { describe, it, expect } from "vitest";
import { buildActivities, type ActivityResolver } from "../../src/wallet/activity";
import { TxType } from "../../src/wallet/index";
import type { ArkTransaction } from "../../src/wallet/index";

function tx(id: string, over: Partial<Omit<ArkTransaction, "key">> = {}): ArkTransaction {
    return {
        key: { arkTxid: id, commitmentTxid: "", boardingTxid: "" },
        type: TxType.TxReceived,
        amount: 100,
        settled: true,
        createdAt: 1000,
        ...over,
    };
}

describe("buildActivities", () => {
    it("with no resolvers, each tx is its own single-member activity (passthrough)", async () => {
        const txs = [tx("a", { amount: 10, createdAt: 1 }), tx("b", { amount: 20, createdAt: 2 })];
        const acts = await buildActivities(txs, []);
        expect(acts).toHaveLength(2);
        const a = acts.find((x) => x.id === "a")!;
        expect(a.txs).toHaveLength(1);
        expect(a.amount).toBe(10);
        expect(a.intent).toBeUndefined();
    });

    it("groups txs sharing a groupId, summing amounts, members oldest-first", async () => {
        const r: ActivityResolver = {
            id: "game",
            resolve: () => [{ groupId: "game:1", label: "Dice game" }],
        };
        const txs = [tx("a", { amount: -50, createdAt: 2 }), tx("b", { amount: 80, createdAt: 5 })];
        const [act] = await buildActivities(txs, [r]);
        expect(act.id).toBe("game:1");
        expect(act.intent?.label).toBe("Dice game");
        expect(act.txs.map((t) => t.key.arkTxid)).toEqual(["a", "b"]);
        expect(act.amount).toBe(30);
    });

    it("splits a batched tx across groups via per-membership amount", async () => {
        const r: ActivityResolver = {
            id: "batch",
            resolve: (t) =>
                t.key.arkTxid === "settle"
                    ? [
                          { groupId: "game:A", label: "Dice game", amount: 5 },
                          { groupId: "game:B", label: "Dice game", amount: 3 },
                      ]
                    : undefined,
        };
        const acts = await buildActivities([tx("settle", { amount: 8 })], [r]);
        expect(acts.find((x) => x.id === "game:A")!.amount).toBe(5);
        expect(acts.find((x) => x.id === "game:B")!.amount).toBe(3);
    });

    it("defaults a membership's contribution to the tx's full amount", async () => {
        const r: ActivityResolver = { id: "g", resolve: () => [{ groupId: "g:1" }] };
        const [act] = await buildActivities([tx("a", { amount: 42 })], [r]);
        expect(act.amount).toBe(42);
    });

    it("merges two resolvers on the same groupId: label first-wins, metadata additive", async () => {
        const r1: ActivityResolver = {
            id: "r1",
            resolve: () => [{ groupId: "x", label: "First", metadata: { a: 1 } }],
        };
        const r2: ActivityResolver = {
            id: "r2",
            resolve: () => [{ groupId: "x", label: "Second", metadata: { b: 2 } }],
        };
        const [act] = await buildActivities([tx("t")], [r1, r2]);
        expect(act.intent?.label).toBe("First");
        expect(act.intent?.metadata).toEqual({ a: 1, b: 2 });
    });

    it("isolates a throwing resolver (one bad tag does not break history)", async () => {
        const bad: ActivityResolver = {
            id: "bad",
            resolve: () => {
                throw new Error("boom");
            },
        };
        const good: ActivityResolver = { id: "good", resolve: () => [{ groupId: "ok" }] };
        const [act] = await buildActivities([tx("t")], [bad, good]);
        expect(act.id).toBe("ok");
    });

    it("sorts activities by most-recent member, descending", async () => {
        const r: ActivityResolver = {
            id: "g",
            resolve: (t) => [{ groupId: `g:${t.key.arkTxid}` }],
        };
        const txs = [tx("old", { createdAt: 1 }), tx("new", { createdAt: 9 })];
        const acts = await buildActivities(txs, [r]);
        expect(acts.map((a) => a.id)).toEqual(["g:new", "g:old"]);
    });

    it("runs prepare() before resolve()", async () => {
        let prepared = false;
        const r: ActivityResolver = {
            id: "g",
            prepare: async () => {
                prepared = true;
            },
            resolve: () => (prepared ? [{ groupId: "g:1" }] : undefined),
        };
        const [act] = await buildActivities([tx("t")], [r]);
        expect(act.id).toBe("g:1");
    });
});
