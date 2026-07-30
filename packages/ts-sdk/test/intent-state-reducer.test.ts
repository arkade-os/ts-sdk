import { describe, it, expect } from "vitest";
import { SettlementEventType } from "../src/providers/ark";
import { reduceIntentState } from "../src/wallet/intentStateReducer";

describe("reduceIntentState", () => {
    it("advances through the batch lifecycle", () => {
        expect(
            reduceIntentState("waiting_for_batch", {
                type: SettlementEventType.BatchStarted,
            } as never),
        ).toBe("batch_in_progress");
        expect(
            reduceIntentState("batch_in_progress", {
                type: SettlementEventType.BatchFinalized,
            } as never),
        ).toBe("batch_succeeded");
        expect(
            reduceIntentState("batch_in_progress", {
                type: SettlementEventType.BatchFailed,
            } as never),
        ).toBe("batch_failed");
    });

    it("is monotonic: never leaves a terminal state", () => {
        for (const ev of [
            SettlementEventType.BatchStarted,
            SettlementEventType.BatchFinalized,
            SettlementEventType.BatchFailed,
        ]) {
            expect(reduceIntentState("batch_succeeded", { type: ev } as never)).toBe(
                "batch_succeeded",
            );
            expect(reduceIntentState("cancelled", { type: ev } as never)).toBe("cancelled");
        }
    });

    it("ignores out-of-order regressive events", () => {
        expect(
            reduceIntentState("batch_succeeded", {
                type: SettlementEventType.BatchStarted,
            } as never),
        ).toBe("batch_succeeded");
    });

    it("returns current state for unmapped (tree/stream) events", () => {
        expect(
            reduceIntentState("waiting_for_batch", {
                type: SettlementEventType.TreeNonces,
            } as never),
        ).toBe("waiting_for_batch");
        expect(
            reduceIntentState("waiting_for_batch", {
                type: SettlementEventType.StreamStarted,
            } as never),
        ).toBe("waiting_for_batch");
    });
});
