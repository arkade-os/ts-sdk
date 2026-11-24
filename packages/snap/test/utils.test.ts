import { describe, it, expect } from "vitest";

import {
    validateInputIndexes,
    validateNetwork,
    validateOperatorUrl,
    validatePsbt,
    isValidNetwork,
} from "../src/utils";

describe("Validation Utilities", () => {
    describe("isValidNetwork", () => {
        it("returns true for valid networks", () => {
            expect(isValidNetwork("bitcoin")).toBe(true);
            expect(isValidNetwork("testnet")).toBe(true);
            expect(isValidNetwork("signet")).toBe(true);
            expect(isValidNetwork("mutinynet")).toBe(true);
            expect(isValidNetwork("regtest")).toBe(true);
        });

        it("returns false for invalid networks", () => {
            expect(isValidNetwork("invalid")).toBe(false);
            expect(isValidNetwork("mainnet")).toBe(false);
            expect(isValidNetwork("")).toBe(false);
            expect(isValidNetwork(123)).toBe(false);
            expect(isValidNetwork(null)).toBe(false);
        });
    });

    describe("validateNetwork", () => {
        it("returns valid network names", () => {
            expect(validateNetwork("bitcoin")).toBe("bitcoin");
            expect(validateNetwork("signet")).toBe("signet");
            expect(validateNetwork("testnet")).toBe("testnet");
        });

        it("throws on non-string network", () => {
            expect(() => validateNetwork(123)).toThrow("Invalid network type: expected string");
            expect(() => validateNetwork(null)).toThrow("Invalid network type: expected string");
            expect(() => validateNetwork(undefined)).toThrow(
                "Invalid network type: expected string",
            );
        });

        it("throws on invalid network name", () => {
            expect(() => validateNetwork("invalid")).toThrow("Invalid network: invalid");
            expect(() => validateNetwork("mainnet")).toThrow("Invalid network: mainnet");
        });
    });

    describe("validateOperatorUrl", () => {
        it("returns the URL without a trailing slash", () => {
            expect(validateOperatorUrl("https://op.example/")).toBe("https://op.example");
            expect(validateOperatorUrl("http://127.0.0.1:7070")).toBe("http://127.0.0.1:7070");
        });

        it("throws on a non-string or unparseable URL", () => {
            expect(() => validateOperatorUrl(7)).toThrow("Invalid operatorUrl type");
            expect(() => validateOperatorUrl("op.example")).toThrow("Invalid operatorUrl");
        });

        it("refuses plain http off loopback", () => {
            expect(() => validateOperatorUrl("http://op.example")).toThrow("https");
        });
    });

    describe("validatePsbt", () => {
        const validPsbt =
            "cHNidP8BAHECAAAAAe6F0YcN3vZJlvFP9kD8YgKK7y1AQBAAAAAAAP////8BAAAAAAAAAAAA";

        it("returns valid base64 PSBT", () => {
            expect(validatePsbt(validPsbt)).toBe(validPsbt);
        });

        it("throws on non-string PSBT", () => {
            expect(() => validatePsbt(123)).toThrow("Invalid psbt type: expected string");
            expect(() => validatePsbt(null)).toThrow("Invalid psbt type: expected string");
        });

        it("throws on empty PSBT", () => {
            expect(() => validatePsbt("")).toThrow("PSBT cannot be empty");
        });

        it("throws on non-base64 format", () => {
            expect(() => validatePsbt("not-base64!@#$")).toThrow("must be a valid base64 string");
            expect(() => validatePsbt("hello world")).toThrow("must be a valid base64 string");
        });

        it("accepts valid base64 with padding", () => {
            expect(validatePsbt("YWJjZA==")).toBe("YWJjZA==");
        });
    });

    describe("validateInputIndexes", () => {
        it("returns valid array of input indexes", () => {
            expect(validateInputIndexes([0])).toEqual([0]);
            expect(validateInputIndexes([0, 1, 2])).toEqual([0, 1, 2]);
            expect(validateInputIndexes([5])).toEqual([5]);
        });

        it("throws on non-array", () => {
            expect(() => validateInputIndexes("not-array")).toThrow(
                "Invalid inputIndexes type: expected array",
            );
            expect(() => validateInputIndexes(123)).toThrow(
                "Invalid inputIndexes type: expected array",
            );
            expect(() => validateInputIndexes(null)).toThrow(
                "Invalid inputIndexes type: expected array",
            );
        });

        it("throws on empty array", () => {
            expect(() => validateInputIndexes([])).toThrow("inputIndexes cannot be empty");
        });

        it("throws on non-number elements", () => {
            expect(() => validateInputIndexes(["0"])).toThrow("expected number");
            expect(() => validateInputIndexes([0, "1"])).toThrow("expected number");
        });

        it("throws on non-integer numbers", () => {
            expect(() => validateInputIndexes([0.5])).toThrow("must be an integer");
            expect(() => validateInputIndexes([0, 1.2])).toThrow("must be an integer");
        });

        it("throws on negative numbers", () => {
            expect(() => validateInputIndexes([-1])).toThrow("must be non-negative");
            expect(() => validateInputIndexes([0, -5])).toThrow("must be non-negative");
        });

        it("accepts large input indexes", () => {
            expect(validateInputIndexes([0, 100, 1000])).toEqual([0, 100, 1000]);
        });
    });
});
