import { describe, expect, it } from "vitest";
import type { ArkadeCashRequest, ArkadeCashResponse } from "../../src";
import {
    addArkadeCashRecord,
    arkadeCashActivity,
    createArkadeCashTracker,
    fundArkadeCashRecord,
    markArkadeCashClaimed,
} from "../../src/arkadeCash/tracker";
import { TxType } from "../../src/wallet";

describe("ArkadeCash activity records", () => {
    it("exposes typed worker operations without exposing token payloads in activities", () => {
        const request: ArkadeCashRequest = { action: "activities", records: [] };
        const response: ArkadeCashResponse = { action: "activities", activities: [] };
        expect(request.action).toBe(response.action);
    });

    it("labels issuance and redemption without exposing the bearer secret", async () => {
        const records = createArkadeCashTracker();
        const cashId = "script-id";
        fundArkadeCashRecord(records, cashId, 5_000, ["funding"], 500);

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

        markArkadeCashClaimed(records, cashId, 5_000, "claimed", ["claim"], 1_500);
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
            issueTxIds: ["funding"],
            claimTxIds: ["claim"],
        });
    });

    it("keeps injection into the worker out of the correlation API", async () => {
        const records = createArkadeCashTracker();
        fundArkadeCashRecord(records, "cash-id", 1, ["funding"], 500);
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
        fundArkadeCashRecord(records, "cash-id", 1, ["funding"], 500);
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
        fundArkadeCashRecord(records, "small", 3_000, ["batch"], 500);
        fundArkadeCashRecord(records, "large", 5_000, ["batch"], 500);
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
        addArkadeCashRecord(records, {
            id: "small",
            action: "issued",
            amount: 3_000,
            createdAt: 1,
            outcome: "available",
            issueTxIds: ["batch"],
            claimTxIds: [],
        });
        addArkadeCashRecord(records, {
            id: "large",
            action: "issued",
            amount: 5_000,
            createdAt: 1,
            outcome: "available",
            issueTxIds: ["batch"],
            claimTxIds: [],
        });
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
});
