import { describe, expect, it } from "vitest";
import {
    decodeRfqAmount,
    encodeRfqAmount,
    fromRfqAmountSide,
    toRfqAmountSide,
    toSafeNumber,
} from "../../src/client/rfqAmount";

describe("the RFQ amount adapter", () => {
    it("emits the canonical decimal string, never a number", () => {
        expect(encodeRfqAmount(100_000n, "amount")).toBe("100000");
        expect(encodeRfqAmount(0n, "amount")).toBe("0");
        expect(encodeRfqAmount(10n ** 29n, "amount")).toBe(`1${"0".repeat(29)}`);
    });

    it("reads the canonical decimal string back exactly", () => {
        expect(decodeRfqAmount("100000", "amount")).toBe(100_000n);
        const past2p53 = 12_345_678_901_234_567_890n;
        expect(decodeRfqAmount(past2p53.toString(), "from_amount")).toBe(past2p53);
    });

    it("accepts a JSON number only inside the safe-integer window", () => {
        // The migration's compatibility arm: the solver landed strings, this
        // side has not, so a number still arrives — but only where it is still
        // the number that was sent.
        expect(decodeRfqAmount(0, "amount")).toBe(0n);
        expect(decodeRfqAmount(Number.MAX_SAFE_INTEGER, "amount")).toBe(
            BigInt(Number.MAX_SAFE_INTEGER),
        );
        expect(() => decodeRfqAmount(Number.MAX_SAFE_INTEGER + 1, "to_amount")).toThrowError(
            expect.objectContaining({ name: "AmountEncodingUnsupported", field: "to_amount" }),
        );
    });

    it.each([
        ["a non-integer", 1.5],
        ["a negative", -1],
        ["a decimal string with a point", "1.0"],
        ["a leading zero", "01"],
        ["null", null],
        ["undefined", undefined],
        ["a bigint the wire cannot carry", 1n],
    ])("refuses %s", (_label, raw) => {
        expect(() => decodeRfqAmount(raw, "amount")).toThrowError(
            expect.objectContaining({ name: "AmountEncodingUnsupported" }),
        );
    });

    it("refuses to emit what the wire cannot hold", () => {
        expect(() => encodeRfqAmount(-1n, "amount")).toThrowError(
            expect.objectContaining({ name: "AmountEncodingUnsupported" }),
        );
        expect(() => encodeRfqAmount(10n ** 30n, "from_amount")).toThrowError(
            expect.objectContaining({ field: "from_amount" }),
        );
    });

    it("narrows to a foreign number amount only where it is exact", () => {
        // Core's payment router types its sats as `number`; M7's rail crosses
        // that boundary here rather than with a bare `Number()`.
        expect(toSafeNumber(100_000n, "amount")).toBe(100_000);
        expect(toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER), "amount")).toBe(
            Number.MAX_SAFE_INTEGER,
        );
        for (const bad of [-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
            expect(() => toSafeNumber(bad, "total"), `${bad}`).toThrowError(
                expect.objectContaining({ name: "AmountEncodingUnsupported", field: "total" }),
            );
        }
    });

    it("owns the side rename, so it cannot spread", () => {
        expect(toRfqAmountSide("give")).toBe("from");
        expect(toRfqAmountSide("take")).toBe("to");
        expect(fromRfqAmountSide("from")).toBe("give");
        expect(fromRfqAmountSide("to")).toBe("take");
    });
});
