import { describe, expect, it } from "vitest";
import { assertNonNegativeMs } from "../src/utils/time";

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
