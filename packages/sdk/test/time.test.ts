import { describe, expect, it } from "vitest";
import { assertNonNegativeMs, assertTimerMs, MAX_TIMER_MS } from "../src/utils/time";

describe("assertNonNegativeMs", () => {
    it.each([undefined, 0, 1, Number.MAX_SAFE_INTEGER])("accepts %s", (ms) => {
        expect(() => assertNonNegativeMs("durationMs", ms)).not.toThrow();
    });

    it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
        "rejects %s",
        (ms) => {
            expect(() => assertNonNegativeMs("durationMs", ms)).toThrow(
                "durationMs must be a non-negative safe integer",
            );
        },
    );
});

describe("assertTimerMs", () => {
    it.each([undefined, 0, 1, MAX_TIMER_MS])("accepts %s", (ms) => {
        expect(() => assertTimerMs("timerMs", ms)).not.toThrow();
    });

    it.each([-1, 0.5, NaN, Infinity, -Infinity])("rejects invalid duration %s", (ms) => {
        expect(() => assertTimerMs("timerMs", ms)).toThrow(
            "timerMs must be a non-negative safe integer",
        );
    });

    it.each([MAX_TIMER_MS + 1, Number.MAX_SAFE_INTEGER])("rejects timer overflow %s", (ms) => {
        expect(() => assertTimerMs("timerMs", ms)).toThrow(
            `timerMs must not exceed ${MAX_TIMER_MS} milliseconds`,
        );
    });
});
