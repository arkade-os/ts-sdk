import { describe, expect, it } from "vitest";
import type { ArkadeCashRequest, ArkadeCashResponse } from "../../src";
import {
    addArkadeCashRecord,
    arkadeCashActivity,
    createArkadeCashTracker,
    mergeArkadeCashRecord,
    type ArkadeCashRecord,
} from "../../src/arkadeCash/tracker";
import { TxType } from "../../src/wallet";

const record = (fields: Partial<ArkadeCashRecord> & { id: string }): ArkadeCashRecord => ({
    action: "issued",
    createdAt: 1,
    outcome: "available",
    issues: [],
    claims: [],
    ...fields,
});

describe("ArkadeCash activity records", () => {
    it("exposes typed worker operations without exposing token payloads in activities", () => {
        const request: ArkadeCashRequest = { action: "activities", records: [] };
        const response: ArkadeCashResponse = { action: "activities", activities: [] };
        expect(request.action).toBe(response.action);
    });

    it("labels issuance and redemption without exposing the bearer secret", async () => {
        const records = createArkadeCashTracker();
        const cashId = "script-id";
        addArkadeCashRecord(
            records,
            record({ id: cashId, createdAt: 500, issues: [{ txid: "funding", amount: 5_000 }] }),
        );

        const [issued] = await arkadeCashActivity(records, [
            {
                key: { arkTxid: "funding", commitmentTxid: "", boardingTxid: "" },
                type: TxType.TxSent,
                amount: 5_000,
                createdAt: 1_000,
                settled: false,
            },
        ]);
        expect(issued.intent).toMatchObject({
            kind: "arkade-cash",
            label: "Cash issued",
            metadata: { cashId },
        });
        expect(JSON.stringify(issued)).not.toContain("tarkadecash1");

        addArkadeCashRecord(
            records,
            record({
                id: cashId,
                action: "claimed",
                createdAt: 1_500,
                outcome: "claimed",
                issues: [{ txid: "funding", amount: 5_000 }],
                claims: [{ txid: "claim", amount: 5_000 }],
            }),
        );
        const [claimed] = await arkadeCashActivity(records, [
            {
                key: { arkTxid: "claim", commitmentTxid: "", boardingTxid: "" },
                type: TxType.TxReceived,
                amount: 5_000,
                createdAt: 2_000,
                settled: true,
            },
        ]);
        expect(claimed.intent).toMatchObject({ label: "Cash claimed", metadata: { cashId } });
        expect(records.get(cashId)).toMatchObject({
            issues: [{ txid: "funding", amount: 5_000 }],
            claims: [{ txid: "claim", amount: 5_000 }],
        });
    });

    it("keeps injection into the worker out of the correlation API", async () => {
        const records = createArkadeCashTracker();
        addArkadeCashRecord(
            records,
            record({ id: "cash-id", createdAt: 500, issues: [{ txid: "funding", amount: 1 }] }),
        );
        const activities = await arkadeCashActivity(records, [
            {
                key: { arkTxid: "funding", commitmentTxid: "", boardingTxid: "" },
                type: TxType.TxSent,
                amount: 1,
                createdAt: 600,
                settled: true,
            },
        ]);
        expect(activities[0].id).toBe("arkade-cash:cash-id");
        expect(activities[0].intent?.metadata).toEqual({ cashId: "cash-id", direction: "issued" });
    });

    it("returns only correlated rows, not the normal history again", async () => {
        const records = createArkadeCashTracker();
        addArkadeCashRecord(
            records,
            record({ id: "cash-id", createdAt: 500, issues: [{ txid: "funding", amount: 1 }] }),
        );
        const activities = await arkadeCashActivity(records, [
            {
                key: { arkTxid: "funding", commitmentTxid: "", boardingTxid: "" },
                type: TxType.TxSent,
                amount: 1,
                createdAt: 600,
                settled: true,
            },
            {
                key: { arkTxid: "other", commitmentTxid: "", boardingTxid: "" },
                type: TxType.TxReceived,
                amount: 2,
                createdAt: 700,
                settled: true,
            },
        ]);
        expect(activities.map((activity) => activity.id)).toEqual(["arkade-cash:cash-id"]);
    });

    it("splits one funding transaction across each voucher contribution", async () => {
        const records = createArkadeCashTracker();
        addArkadeCashRecord(
            records,
            record({ id: "small", createdAt: 500, issues: [{ txid: "batch", amount: 3_000 }] }),
        );
        addArkadeCashRecord(
            records,
            record({ id: "large", createdAt: 500, issues: [{ txid: "batch", amount: 5_000 }] }),
        );
        const activities = await arkadeCashActivity(records, [
            {
                key: { arkTxid: "batch", commitmentTxid: "", boardingTxid: "" },
                type: TxType.TxSent,
                amount: 8_000,
                createdAt: 600,
                settled: true,
            },
        ]);
        expect(activities.map((activity) => [activity.id, activity.amount])).toEqual([
            ["arkade-cash:small", -3_000],
            ["arkade-cash:large", -5_000],
        ]);
    });

    it("retains per-voucher shares when the worker injects public records", async () => {
        const records = createArkadeCashTracker();
        addArkadeCashRecord(
            records,
            record({ id: "small", issues: [{ txid: "batch", amount: 3_000 }] }),
        );
        addArkadeCashRecord(
            records,
            record({ id: "large", issues: [{ txid: "batch", amount: 5_000 }] }),
        );
        const activities = await arkadeCashActivity(records, [
            {
                key: { arkTxid: "batch", commitmentTxid: "", boardingTxid: "" },
                type: TxType.TxSent,
                amount: 8_000,
                createdAt: 2,
                settled: true,
            },
        ]);
        expect(activities.map((activity) => activity.amount)).toEqual([-3_000, -5_000]);
    });

    it("sums the voucher's per-transaction claim shares into one activity", async () => {
        const records = createArkadeCashTracker();
        addArkadeCashRecord(
            records,
            record({
                id: "multi",
                action: "claimed",
                outcome: "claimed",
                claims: [
                    { txid: "t1", amount: 3_000 },
                    { txid: "t2", amount: 2_000 },
                ],
            }),
        );
        const received = (arkTxid: string, amount: number) => ({
            key: { arkTxid, commitmentTxid: "", boardingTxid: "" },
            type: TxType.TxReceived,
            amount,
            createdAt: 2,
            settled: true,
        });
        const activities = await arkadeCashActivity(records, [
            received("t1", 9_999),
            received("t2", 9_999),
        ]);
        // The shares come from the record (3k + 2k), not from the txs' own 9,999.
        expect(activities.map((activity) => activity.amount)).toEqual([5_000]);
    });

    it("keeps the claim when an issued record is added after it", async () => {
        const records = createArkadeCashTracker();
        addArkadeCashRecord(
            records,
            record({
                id: "v",
                action: "claimed",
                outcome: "claimed",
                createdAt: 20,
                claims: [{ txid: "claim", amount: 5_000 }],
            }),
        );
        addArkadeCashRecord(
            records,
            record({ id: "v", createdAt: 10, issues: [{ txid: "funding", amount: 5_000 }] }),
        );
        expect(records.get("v")).toEqual({
            id: "v",
            action: "claimed",
            outcome: "claimed",
            createdAt: 10,
            issues: [{ txid: "funding", amount: 5_000 }],
            claims: [{ txid: "claim", amount: 5_000 }],
        });
    });

    it("lets the later record win between records of the same action", () => {
        const merged = mergeArkadeCashRecord(
            record({
                id: "v",
                action: "claimed",
                outcome: "claimed",
                claims: [{ txid: "sweep", amount: 3_000 }],
            }),
            record({
                id: "v",
                action: "claimed",
                outcome: "recovered",
                claims: [{ txid: "settle", amount: 2_000 }],
            }),
        );
        expect(merged.outcome).toBe("recovered");
        expect(merged.claims.map((claim) => claim.txid)).toEqual(["sweep", "settle"]);
    });
});
