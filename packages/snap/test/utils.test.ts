import { describe, it, expect } from "vitest";

import {
    validateInputIndexes,
    validateNetwork,
    validatePsbt,
    validateSignerPubkey,
    validateUnilateralExitDelay,
    isValidHex,
    isValidNetwork,
} from "../src/utils";

describe("Validation Utilities", () => {
    describe("isValidHex", () => {
        it("returns true for valid hex strings", () => {
            expect(isValidHex("0123456789abcdef")).toBe(true);
            expect(isValidHex("ABCDEF")).toBe(true);
            expect(isValidHex("a1b2c3")).toBe(true);
        });

        it("returns false for invalid hex strings", () => {
            expect(isValidHex("xyz")).toBe(false);
            expect(isValidHex("0x123")).toBe(false);
            expect(isValidHex("g123")).toBe(false);
            expect(isValidHex("")).toBe(false);
        });
    });

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

    describe("validateSignerPubkey", () => {
        const validPubkey = "a".repeat(64);

        it("returns valid x-only public key", () => {
            expect(validateSignerPubkey(validPubkey)).toBe(validPubkey);
        });

        it("throws on non-string pubkey", () => {
            expect(() => validateSignerPubkey(123)).toThrow(
                "Invalid signerPubkey type: expected string",
            );
            expect(() => validateSignerPubkey(null)).toThrow(
                "Invalid signerPubkey type: expected string",
            );
        });

        it("throws on empty pubkey", () => {
            expect(() => validateSignerPubkey("")).toThrow("signerPubkey cannot be empty");
        });

        it("throws on non-hex pubkey", () => {
            expect(() => validateSignerPubkey(`xyz${"a".repeat(61)}`)).toThrow(
                "must be a valid hex string",
            );
        });

        it("throws on incorrect length (not 64 chars)", () => {
            expect(() => validateSignerPubkey("a".repeat(32))).toThrow(
                "expected 64 hex characters",
            );
            expect(() => validateSignerPubkey("a".repeat(66))).toThrow(
                "expected 64 hex characters",
            );
        });

        it("accepts lowercase and uppercase hex", () => {
            expect(validateSignerPubkey("A".repeat(64))).toBe("A".repeat(64));
            expect(validateSignerPubkey("f".repeat(64))).toBe("f".repeat(64));
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

    describe("validateUnilateralExitDelay", () => {
        it("accepts and converts string to bigint", () => {
            expect(validateUnilateralExitDelay("512")).toBe(512n);
            expect(validateUnilateralExitDelay("1024")).toBe(1024n);
        });

        it("accepts and converts number to bigint", () => {
            expect(validateUnilateralExitDelay(512)).toBe(512n);
            expect(validateUnilateralExitDelay(1024)).toBe(1024n);
        });

        it("accepts bigint directly", () => {
            expect(validateUnilateralExitDelay(512n)).toBe(512n);
        });

        it("throws on non-numeric types", () => {
            expect(() => validateUnilateralExitDelay(null)).toThrow(
                "Invalid unilateralExitDelay type",
            );
            expect(() => validateUnilateralExitDelay(undefined)).toThrow(
                "Invalid unilateralExitDelay type",
            );
            expect(() => validateUnilateralExitDelay({})).toThrow(
                "Invalid unilateralExitDelay type",
            );
        });

        it("throws on invalid numeric string", () => {
            expect(() => validateUnilateralExitDelay("not-a-number")).toThrow(
                "is not a valid number",
            );
            expect(() => validateUnilateralExitDelay("12.34")).toThrow("is not a valid number");
        });

        it("throws on negative values", () => {
            expect(() => validateUnilateralExitDelay("-1")).toThrow("must be non-negative");
            expect(() => validateUnilateralExitDelay(-512)).toThrow("must be non-negative");
        });

        it("accepts zero", () => {
            expect(validateUnilateralExitDelay("0")).toBe(0n);
            expect(validateUnilateralExitDelay(0)).toBe(0n);
        });

        it("accepts large numbers", () => {
            expect(validateUnilateralExitDelay("999999999999")).toBe(999999999999n);
        });
    });
});
