import { describe, expect, it } from "vitest";
import {
    Amount,
    AmountFormatError,
    fromAtomicDecimal,
    toAtomicDecimal,
} from "../../src/client/amount";

const BTC = { decimals: 8 };
const ETH = { decimals: 18 };
const SATS = { decimals: 0 };

describe("the scaled decimal, at the UI edge", () => {
    it("round-trips at 8 decimals", () => {
        expect(Amount.parse("0.01", BTC)).toBe(1_000_000n);
        expect(Amount.format(1_000_000n, BTC)).toBe("0.01");
        expect(Amount.format(Amount.parse("21000000", BTC), BTC)).toBe("21000000");
    });

    it("round-trips at 18 decimals, where a float would already be wrong", () => {
        expect(Amount.parse("1.000000000000000001", ETH)).toBe(1_000_000_000_000_000_001n);
        expect(Amount.format(1_000_000_000_000_000_001n, ETH)).toBe("1.000000000000000001");
    });

    it("is the identity at 0 decimals", () => {
        expect(Amount.parse("100000", SATS)).toBe(100_000n);
        expect(Amount.format(100_000n, SATS)).toBe("100000");
    });

    it("refuses a finer amount rather than truncating it", () => {
        // A truncated amount is a swap for the wrong size, and nothing
        // downstream can tell it was ever a different number.
        expect(() => Amount.parse("0.000000001", BTC)).toThrowError(
            expect.objectContaining({ name: "AmountFormatError", reason: "too_precise" }),
        );
    });

    it.each([
        ["a JS number's spelling of sats", "1e5"],
        ["a negative", "-1"],
        ["leading whitespace", " 1"],
        ["a bare point", "1."],
        ["a leading point", ".5"],
        ["nothing at all", ""],
        ["a word", "abc"],
        ["a thousands separator", "1,000"],
    ])("refuses %s", (_label, input) => {
        expect(() => Amount.parse(input, BTC)).toThrowError(
            expect.objectContaining({ name: "AmountFormatError", reason: "not_decimal" }),
        );
    });

    it("refuses an asset scale no registry can advertise", () => {
        expect(() => Amount.parse("1", { decimals: 19 })).toThrowError(
            expect.objectContaining({ reason: "invalid_decimals" }),
        );
        expect(() => Amount.format(1n, { decimals: -1 })).toThrowError(
            expect.objectContaining({ reason: "invalid_decimals" }),
        );
    });

    it("refuses a negative obligation", () => {
        expect(() => Amount.format(-1n, BTC)).toThrowError(
            expect.objectContaining({ reason: "negative" }),
        );
    });
});

describe("the atomic decimal, at the record and wire edge", () => {
    it("is the same integer written out, never scaled", () => {
        // The distinction this pair exists for: 1_000_000n is "0.01" to a user
        // and "1000000" to a record, and conflating them is the v1 footgun.
        expect(toAtomicDecimal(1_000_000n)).toBe("1000000");
        expect(Amount.format(1_000_000n, BTC)).toBe("0.01");
        expect(fromAtomicDecimal("1000000")).toBe(1_000_000n);
        expect(toAtomicDecimal(0n)).toBe("0");
    });

    it("holds an amount no JSON number could", () => {
        const big = 10n ** 29n;
        expect(fromAtomicDecimal(toAtomicDecimal(big))).toBe(big);
        expect(Number.isSafeInteger(Number(big))).toBe(false);
    });

    it("refuses anything outside the canonical form", () => {
        expect(() => toAtomicDecimal(-1n)).toThrowError(
            expect.objectContaining({ reason: "negative" }),
        );
        // 31 digits, past the wire's bound.
        expect(() => toAtomicDecimal(10n ** 30n)).toThrowError(
            expect.objectContaining({ reason: "too_large" }),
        );
        for (const bad of ["01", "1.0", "", "-1", " 1", "1e5"]) {
            expect(() => fromAtomicDecimal(bad), bad).toThrow(AmountFormatError);
        }
    });
});
