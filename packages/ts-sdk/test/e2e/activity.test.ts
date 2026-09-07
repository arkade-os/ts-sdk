/**
 * The activity resolver against a real wallet history.
 *
 * Every transaction in `buildActivities`' unit suite is hand-built, which is
 * what it cannot check: a hand-built `ArkTransaction` agrees with the resolver
 * by construction, whether or not the real `getTransactionHistory()` populates
 * `key.boardingTxid`, `type` and `tag` the same way. These rows come from a real
 * boarding, settle and offchain send.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { boardingResolver, TxType, type ActivityResolver, type ArkTransaction } from "../../src";
import {
    beforeEachFaucet,
    createTestArkWallet,
    execCommand,
    waitFor,
    type TestArkWallet,
} from "./utils";

const BOARDING_SATS = 10_000;
const SEND_SATS = 2_000;

let alice: TestArkWallet;
let bob: TestArkWallet;
let boardingTxid: string;
let sendTxid: string;

/** Every resolver the wallet ships, plus whatever this case registers. */
const activitiesWith = async (...extra: ActivityResolver[]) => {
    for (const resolver of extra) alice.wallet.activity.use(resolver);
    try {
        return await alice.wallet.getActivityHistory();
    } finally {
        for (const resolver of extra) alice.wallet.activity.remove(resolver.id);
    }
};

beforeAll(async () => {
    await beforeEachFaucet();
    alice = await createTestArkWallet();
    bob = await createTestArkWallet();

    const boardingAddress = await alice.wallet.getBoardingAddress();
    execCommand(
        `node regtest/regtest.mjs faucet ${boardingAddress} ${(BOARDING_SATS * 1e-8).toFixed(8)} --confirm`,
    );
    await waitFor(async () => (await alice.wallet.getBoardingUtxos()).length > 0);

    const inputs = await alice.wallet.getBoardingUtxos();
    boardingTxid = inputs[0].txid;
    await alice.wallet.settle({
        inputs,
        outputs: [{ address: await alice.wallet.getAddress(), amount: BigInt(BOARDING_SATS) }],
    });
    execCommand("node regtest/regtest.mjs mine 1");
    await waitFor(async () => (await alice.wallet.getVtxos()).length > 0);

    sendTxid = await alice.wallet.send({
        address: await bob.wallet.getAddress(),
        amount: SEND_SATS,
    });
    await waitFor(async () => (await alice.wallet.getTransactionHistory()).length >= 2);
}, 180_000);

describe("the built-in resolvers, against a real history (regtest)", () => {
    it("groups the real boarding transaction under the boarding resolver", async () => {
        const activities = await alice.wallet.getActivityHistory();

        const boarding = activities.find((a) => a.id === `boarding:${boardingTxid}`);
        expect(boarding).toBeDefined();
        expect(boarding?.intent).toMatchObject({ label: "Deposit", kind: "boarding" });
        expect(boarding?.amount).toBe(BOARDING_SATS);
        expect(boarding?.txs.every((tx) => tx.key.boardingTxid === boardingTxid)).toBe(true);
    }, 120_000);

    it("leaves the send ungrouped, bucketed by its own transaction key", async () => {
        const activities = await alice.wallet.getActivityHistory();

        const send = activities.find((a) => a.id === sendTxid);
        expect(send).toBeDefined();
        expect(send?.intent).toBeUndefined();
        expect(send?.amount).toBe(-SEND_SATS);
        expect(send?.txs[0].type).toBe(TxType.TxSent);
    }, 120_000);

    it("falls back to a plain row once the boarding resolver is removed", async () => {
        alice.wallet.activity.remove("boarding");
        try {
            const activities = await alice.wallet.getActivityHistory();
            expect(activities.some((a) => a.id === `boarding:${boardingTxid}`)).toBe(false);
            // Found by its member rather than by a predicted id: the natural key
            // is `arkTxid || commitmentTxid || boardingTxid`, so once the settle's
            // commitment lands on the row the bucket is no longer the boarding
            // txid. The claim here is that the row survives ungrouped, not which
            // of the three it buckets under.
            const plain = activities.find((a) =>
                a.txs.some((tx) => tx.key.boardingTxid === boardingTxid),
            );
            expect(plain).toBeDefined();
            expect(plain?.intent).toBeUndefined();
        } finally {
            // Restore for the cases that follow; the registry is wallet-wide.
            alice.wallet.activity.use(boardingResolver());
        }
    }, 120_000);
});

describe("a custom resolver over real transactions (regtest)", () => {
    it("collapses the boarding and the send into one activity that nets", async () => {
        const activities = await activitiesWith({
            id: "test:both",
            resolve: (tx: ArkTransaction) =>
                tx.key.boardingTxid === boardingTxid || tx.key.arkTxid === sendTxid
                    ? [{ groupId: "test:group", label: "Both", kind: "test" }]
                    : undefined,
        });

        const grouped = activities.find((a) => a.id === "test:group");
        expect(grouped).toBeDefined();
        expect(grouped?.intent).toMatchObject({ label: "Both", kind: "test" });
        expect(grouped?.txs).toHaveLength(2);
        // Signed by direction: the deposit came in, the send went out.
        expect(grouped?.amount).toBe(BOARDING_SATS - SEND_SATS);
    }, 120_000);

    it("prepares before it resolves, and can correlate on what prepare loaded", async () => {
        const seen: string[] = [];
        // The correlation data lands a macrotask later, so a builder that
        // CALLED `prepare()` without awaiting it resolves against an empty
        // table and fails here. A microtask boundary is not enough: the
        // surrounding `await Promise.all` flushes those anyway.
        let loaded: string | undefined;
        const activities = await activitiesWith({
            id: "test:prepared",
            prepare: async () => {
                seen.push("prepare");
                await new Promise((r) => setTimeout(r, 0));
                loaded = sendTxid;
            },
            resolve: (tx) => {
                seen.push("resolve");
                return loaded !== undefined && tx.key.arkTxid === loaded
                    ? [{ groupId: "test:prepared-group", label: "Prepared" }]
                    : undefined;
            },
        });

        expect(seen[0]).toBe("prepare");
        expect(activities.find((a) => a.id === "test:prepared-group")?.intent?.label).toBe(
            "Prepared",
        );
    }, 120_000);
});

describe("a resolver the builder has to survive (regtest)", () => {
    it("isolates one that throws on every real row", async () => {
        const activities = await activitiesWith({
            id: "test:thrower",
            resolve: () => {
                throw new Error("resolver is broken");
            },
        });

        // The built-ins still did their job, which is what isolation means.
        expect(activities.some((a) => a.id === `boarding:${boardingTxid}`)).toBe(true);
        expect(activities.some((a) => a.id === sendTxid)).toBe(true);
    }, 120_000);

    it("isolates one whose prepare rejects, keeping its resolve out entirely", async () => {
        let resolved = 0;
        const activities = await activitiesWith({
            id: "test:bad-prepare",
            prepare: async () => {
                throw new Error("could not load");
            },
            resolve: () => {
                resolved += 1;
                return [{ groupId: "test:never", label: "Never" }];
            },
        });

        expect(resolved).toBe(0);
        expect(activities.some((a) => a.id === "test:never")).toBe(false);
        expect(activities.some((a) => a.id === `boarding:${boardingTxid}`)).toBe(true);
    }, 120_000);

    it("drops memberships it cannot use, and keeps the row it would have taken", async () => {
        const activities = await activitiesWith({
            id: "test:bad-shapes",
            resolve: (tx) =>
                tx.key.arkTxid === sendTxid
                    ? [
                          { groupId: "", label: "Empty id" },
                          { groupId: "test:nan", amount: Number.NaN },
                      ]
                    : undefined,
        });

        expect(activities.some((a) => a.id === "")).toBe(false);
        expect(activities.some((a) => a.id === "test:nan")).toBe(false);
        // Every membership was dropped, so the row is plain again rather than lost.
        expect(activities.find((a) => a.id === sendTxid)?.amount).toBe(-SEND_SATS);
    }, 120_000);

    it("keeps the first writer's intent when two resolvers claim one group", async () => {
        const claim = (id: string, label: string): ActivityResolver => ({
            id,
            resolve: (tx) =>
                tx.key.arkTxid === sendTxid
                    ? [{ groupId: "test:shared", label, metadata: { [id]: true } }]
                    : undefined,
        });
        const activities = await activitiesWith(
            claim("test:first", "First"),
            claim("test:second", "Second"),
        );

        const shared = activities.find((a) => a.id === "test:shared");
        expect(shared?.intent?.label).toBe("First");
        expect(shared?.intent?.metadata).toMatchObject({ "test:first": true, "test:second": true });
    }, 120_000);
});

describe("the registry itself (regtest)", () => {
    it("ships the three built-ins and overwrites by id", async () => {
        expect(alice.wallet.activity.list()).toEqual(
            expect.arrayContaining(["boarding", "collab-exit", "asset-mint"]),
        );

        const before = alice.wallet.activity.list().length;
        alice.wallet.activity.use({ id: "boarding", resolve: () => undefined });
        try {
            expect(alice.wallet.activity.list().length).toBe(before);
            const activities = await alice.wallet.getActivityHistory();
            // The override answers nothing, so the real boarding row is plain.
            expect(activities.some((a) => a.id === `boarding:${boardingTxid}`)).toBe(false);
        } finally {
            alice.wallet.activity.use(boardingResolver());
        }
    }, 120_000);
});
