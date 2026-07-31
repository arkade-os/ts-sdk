import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    buildActivities,
    ActivityRegistry,
    boardingResolver,
    collabExitResolver,
    assetMintResolver,
    createDefaultActivityRegistry,
    type ActivityResolver,
} from "../../src/wallet/activity";
import { AssetId } from "../../src/extension/asset/assetId";
import {
    makeStaticWalletForTest,
    installRestoreHarness,
    teardownRestoreHarness,
} from "../helpers/restoreWallet";
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
    it("with no resolvers, distinct txs are single-member activities (passthrough)", async () => {
        const txs = [tx("a", { amount: 10, createdAt: 1 }), tx("b", { amount: 20, createdAt: 2 })];
        const acts = await buildActivities(txs, []);
        expect(acts).toHaveLength(2);
        const a = acts.find((x) => x.id === "a")!;
        expect(a.txs).toHaveLength(1);
        expect(a.amount).toBe(10);
        expect(a.intent).toBeUndefined();
    });

    it("nets ungrouped same-arkTxid send/change rows into one sent activity", async () => {
        const txs = [
            tx("same", { type: TxType.TxSent, amount: 300, createdAt: 2 }),
            tx("same", { type: TxType.TxReceived, amount: 700, createdAt: 2 }),
        ];
        const [act] = await buildActivities(txs, []);
        expect(act.id).toBe("same");
        expect(act.amount).toBe(-300);
        expect(act.txs).toEqual(txs);
    });

    it("nets grouped same-arkTxid send/change rows into one sent activity", async () => {
        const r: ActivityResolver = {
            id: "app",
            resolve: (t) => [{ groupId: `app:${t.key.arkTxid}` }],
        };
        const txs = [
            tx("same", { type: TxType.TxSent, amount: 300, createdAt: 2 }),
            tx("same", { type: TxType.TxReceived, amount: 700, createdAt: 2 }),
        ];
        const [act] = await buildActivities(txs, [r]);
        expect(act.id).toBe("app:same");
        expect(act.amount).toBe(-300);
        expect(act.txs).toEqual(txs);
    });

    it("groups txs sharing a groupId, netting sent and received amounts", async () => {
        const r: ActivityResolver = {
            id: "game",
            resolve: () => [{ groupId: "game:1", label: "Dice game" }],
        };
        const txs = [
            tx("a", { type: TxType.TxSent, amount: 50, createdAt: 2 }),
            tx("b", { type: TxType.TxReceived, amount: 80, createdAt: 5 }),
        ];
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
        const acts = await buildActivities([tx("settle", { type: TxType.TxSent, amount: 8 })], [r]);
        expect(acts.find((x) => x.id === "game:A")!.amount).toBe(-5);
        expect(acts.find((x) => x.id === "game:B")!.amount).toBe(-3);
    });

    it("defaults a membership's contribution to the tx's signed amount", async () => {
        const r: ActivityResolver = { id: "g", resolve: () => [{ groupId: "g:1" }] };
        const [received] = await buildActivities([tx("a", { amount: 42 })], [r]);
        expect(received.amount).toBe(42);

        const [sent] = await buildActivities([tx("b", { type: TxType.TxSent, amount: 42 })], [r]);
        expect(sent.amount).toBe(-42);
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

    it("isolates a resolver whose prepare() rejects (a bad prepare does not break history)", async () => {
        const bad: ActivityResolver = {
            id: "bad",
            prepare: async () => {
                throw new Error("prepare boom");
            },
            resolve: () => [{ groupId: "stale" }],
        };
        const good: ActivityResolver = { id: "good", resolve: () => [{ groupId: "ok" }] };
        const acts = await buildActivities([tx("t")], [bad, good]);
        expect(acts.map((act) => act.id)).toEqual(["ok"]);
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

describe("ActivityRegistry", () => {
    it("use/list/all in order, override in place, remove", () => {
        const reg = new ActivityRegistry();
        const a: ActivityResolver = { id: "a", resolve: () => undefined };
        const b: ActivityResolver = { id: "b", resolve: () => undefined };
        reg.use(a);
        reg.use(b);
        expect(reg.list()).toEqual(["a", "b"]);
        const a2: ActivityResolver = { id: "a", resolve: () => [{ groupId: "x" }] };
        reg.use(a2);
        expect(reg.list()).toEqual(["a", "b"]);
        expect(reg.all()[0]).toBe(a2);
        reg.remove("b");
        expect(reg.list()).toEqual(["a"]);
    });
});

describe("wallet.getActivityHistory", () => {
    // Wallet.create resolves the ark /info over the global fetch; stub it
    // (and EventSource) so the test never reaches a live :7070 ark server.
    beforeEach(installRestoreHarness);
    afterEach(teardownRestoreHarness);

    it("groups getTransactionHistory via the registered resolvers", async () => {
        const { wallet } = await makeStaticWalletForTest();
        vi.spyOn(wallet, "getTransactionHistory").mockResolvedValue([
            tx("a", { createdAt: 1 }),
            tx("b", { createdAt: 2 }),
        ]);
        wallet.activity.use({ id: "g", resolve: () => [{ groupId: "g:1", label: "Grouped" }] });
        const acts = await wallet.getActivityHistory();
        expect(acts).toHaveLength(1);
        expect(acts[0].id).toBe("g:1");
        expect(acts[0].intent?.label).toBe("Grouped");
        expect(acts[0].txs).toHaveLength(2);
    });

    it("preserves every getTransactionHistory row in the activity view", async () => {
        const { wallet } = await makeStaticWalletForTest();
        const history = [
            tx("same", { type: TxType.TxSent, amount: 300, createdAt: 2 }),
            tx("same", { type: TxType.TxReceived, amount: 700, createdAt: 2 }),
            tx("other", { type: TxType.TxReceived, amount: 50, createdAt: 1 }),
        ];
        vi.spyOn(wallet, "getTransactionHistory").mockResolvedValue(history);

        const acts = await wallet.getActivityHistory();
        const flattened = acts.flatMap((a) => a.txs);

        expect(flattened).toHaveLength(history.length);
        for (const row of history) {
            expect(flattened).toContain(row);
        }
        expect(acts.find((a) => a.id === "same")?.txs).toEqual([history[0], history[1]]);
    });
});

describe("boardingResolver", () => {
    it("tags a tx with a boardingTxid as a Deposit; ignores others", () => {
        const r = boardingResolver();
        const boarding: ArkTransaction = {
            key: { arkTxid: "", commitmentTxid: "", boardingTxid: "bX" },
            type: TxType.TxReceived,
            amount: 1,
            settled: true,
            createdAt: 1,
        };
        expect(r.resolve(boarding)).toEqual([
            { groupId: "boarding:bX", label: "Deposit", kind: "boarding" },
        ]);
        expect(r.resolve(tx("a"))).toBeUndefined();
    });
});

describe("collabExitResolver", () => {
    it("tags an exit tx by its commitment; ignores non-exit", () => {
        const r = collabExitResolver();
        const exit: ArkTransaction = {
            key: { arkTxid: "", commitmentTxid: "cX", boardingTxid: "" },
            type: TxType.TxSent,
            amount: -100,
            settled: true,
            createdAt: 1,
            tag: "exit",
        };
        expect(r.resolve(exit)).toEqual([
            { groupId: "exit:cX", label: "Collaborative exit", kind: "exit" },
        ]);
        expect(r.resolve(tx("a", { tag: "offchain" }))).toBeUndefined();
    });
});

describe("assetMintResolver", () => {
    it("tags the genesis tx of a minted asset; ignores reissue and non-asset txs", () => {
        const r = assetMintResolver();
        const genesisTxid = "11".repeat(32);
        const assetId = AssetId.create(genesisTxid, 0).toString();

        const mint: ArkTransaction = {
            key: { arkTxid: genesisTxid, commitmentTxid: "", boardingTxid: "" },
            type: TxType.TxSent,
            amount: 0,
            settled: true,
            createdAt: 1,
            assets: [{ assetId, amount: 1000n }],
            tag: "offchain",
        };
        expect(r.resolve(mint)).toEqual([
            {
                groupId: `mint:${assetId}`,
                label: "Asset mint",
                kind: "asset-mint",
                metadata: { assetId, amount: "1000" },
            },
        ]);

        // an asset carried by a tx that is NOT its genesis (transfer/reissue) is not a mint here
        const transfer: ArkTransaction = {
            key: { arkTxid: "22".repeat(32), commitmentTxid: "", boardingTxid: "" },
            type: TxType.TxSent,
            amount: 0,
            settled: true,
            createdAt: 1,
            assets: [{ assetId, amount: 500n }],
            tag: "offchain",
        };
        expect(r.resolve(transfer)).toBeUndefined();
        expect(r.resolve(tx("a"))).toBeUndefined();
    });

    it("matches the genesis txid byte-for-byte, at any group index", () => {
        const r = assetMintResolver();
        // Asymmetric on purpose: a byte-order slip between the assetId's embedded
        // txid and tx.key.arkTxid would survive a palindromic txid unnoticed.
        const genesisTxid = "01020304" + "aa".repeat(24) + "0b0c0d0e";
        const assetId = AssetId.create(genesisTxid, 7).toString();

        const mint: ArkTransaction = {
            key: { arkTxid: genesisTxid, commitmentTxid: "", boardingTxid: "" },
            type: TxType.TxSent,
            amount: 0,
            settled: true,
            createdAt: 1,
            assets: [{ assetId, amount: 1n }],
            tag: "offchain",
        };
        expect(r.resolve(mint)?.[0].groupId).toBe(`mint:${assetId}`);

        // same bytes reversed: must not be taken for the genesis tx
        const reversed = (genesisTxid.match(/../g) ?? []).reverse().join("");
        expect(reversed).not.toBe(genesisTxid);
        expect(r.resolve({ ...mint, key: { ...mint.key, arkTxid: reversed } })).toBeUndefined();
    });

    it("tags fresh supply received in the genesis tx as an asset receive", () => {
        const r = assetMintResolver();
        const genesisTxid = "33".repeat(32);
        const assetId = AssetId.create(genesisTxid, 0).toString();

        const receive: ArkTransaction = {
            key: { arkTxid: genesisTxid, commitmentTxid: "", boardingTxid: "" },
            type: TxType.TxReceived,
            amount: 0,
            settled: true,
            createdAt: 1,
            assets: [{ assetId, amount: 250n }],
            tag: "offchain",
        };
        expect(r.resolve(receive)).toEqual([
            {
                groupId: `mint:${assetId}`,
                label: "Asset receive",
                kind: "asset-receive",
                metadata: { assetId, amount: "250" },
            },
        ]);
    });
});

describe("createDefaultActivityRegistry", () => {
    it("pre-registers the built-in resolvers in order", () => {
        expect(createDefaultActivityRegistry().list()).toEqual([
            "boarding",
            "collab-exit",
            "asset-mint",
        ]);
    });
});
