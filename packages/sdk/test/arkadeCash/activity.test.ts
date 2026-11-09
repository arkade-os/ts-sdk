import { describe, expect, it } from "vitest";
import type { ArkadeCashRequest, ArkadeCashResponse } from "../../src";
import {
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
        await fundArkadeCashRecord(records, cashId, 5_000, ["funding"], 500);

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

        await markArkadeCashClaimed(records, cashId, 5_000, "claimed", ["claim"], 1_500);
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
    });

    it("keeps injection into the worker out of the correlation API", async () => {
        const records = createArkadeCashTracker();
        await fundArkadeCashRecord(records, "cash-id", 1, ["funding"], 500);
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
        await fundArkadeCashRecord(records, "cash-id", 1, ["funding"], 500);
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
});
