import { describe, it, expect } from "vitest";
import { SettlementEventType } from "../src/providers/ark";
import { reduceRegistrationState } from "../src/wallet/batchRegistrationStateReducer";

describe("reduceIntentState", () => {
    it("advances through the batch lifecycle", () => {
        expect(
            reduceRegistrationState("waiting_for_batch", {
                type: SettlementEventType.BatchStarted,
            } as never),
        ).toBe("batch_in_progress");
        expect(
            reduceRegistrationState("batch_in_progress", {
                type: SettlementEventType.BatchFinalized,
            } as never),
        ).toBe("batch_succeeded");
        expect(
            reduceRegistrationState("batch_in_progress", {
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
            expect(reduceRegistrationState("batch_succeeded", { type: ev } as never)).toBe(
                "batch_succeeded",
            );
            expect(reduceRegistrationState("cancelled", { type: ev } as never)).toBe("cancelled");
        }
    });

    it("ignores out-of-order regressive events", () => {
        expect(
            reduceRegistrationState("batch_succeeded", {
                type: SettlementEventType.BatchStarted,
            } as never),
        ).toBe("batch_succeeded");
    });

    it("returns current state for unmapped (tree/stream) events", () => {
        expect(
            reduceRegistrationState("waiting_for_batch", {
                type: SettlementEventType.TreeNonces,
            } as never),
        ).toBe("waiting_for_batch");
        expect(
            reduceRegistrationState("waiting_for_batch", {
                type: SettlementEventType.StreamStarted,
            } as never),
        ).toBe("waiting_for_batch");
    });
});
