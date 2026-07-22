import { describe, it, expect } from "vitest";
import {
    resolveSendAmount,
    assertSendableAmount,
    tryResolveSendAmount,
} from "../../src/payment/amount";

const btcAddr = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7k";

describe("assertSendableAmount", () => {
    it("accepts a positive integer", () => {
        expect(() => assertSendableAmount("x", 1000)).not.toThrow();
    });
    it("rejects zero, negative, and fractional amounts", () => {
        expect(() => assertSendableAmount("x", 0)).toThrow(/invalid amount 0/i);
        expect(() => assertSendableAmount("x", -5)).toThrow(/invalid amount -5/i);
        expect(() => assertSendableAmount("x", 1.5)).toThrow(/invalid amount 1.5/i);
    });
});

describe("resolveSendAmount", () => {
    it("prefers the explicit amount", () => {
        expect(resolveSendAmount("x", btcAddr, 1000)).toBe(1000);
    });
    it("falls back to the BIP21-encoded amount (BTC -> sats)", () => {
        expect(resolveSendAmount("x", `bitcoin:${btcAddr}?amount=0.00001`, undefined)).toBe(1000);
    });
    it("throws when no amount is provided or encoded", () => {
        expect(() => resolveSendAmount("x", btcAddr, undefined)).toThrow(/amount is required/i);
    });
    it("rejects an explicit zero / fractional amount", () => {
        expect(() => resolveSendAmount("x", btcAddr, 0)).toThrow(/invalid amount/i);
        expect(() => resolveSendAmount("x", btcAddr, 2.5)).toThrow(/invalid amount/i);
    });
});

describe("tryResolveSendAmount", () => {
    it("returns the explicit amount", () => {
        expect(tryResolveSendAmount(btcAddr, 1000)).toBe(1000);
    });
    it("falls back to the BIP21-encoded amount (BTC -> sats)", () => {
        expect(tryResolveSendAmount(`bitcoin:${btcAddr}?amount=0.00001`)).toBe(1000);
    });
    it("returns undefined when no amount is provided or encoded", () => {
        expect(tryResolveSendAmount(btcAddr)).toBeUndefined();
    });
    it("returns undefined for zero, negative, and fractional amounts", () => {
        expect(tryResolveSendAmount(btcAddr, 0)).toBeUndefined();
        expect(tryResolveSendAmount(btcAddr, -5)).toBeUndefined();
        expect(tryResolveSendAmount(btcAddr, 1.5)).toBeUndefined();
    });
});
