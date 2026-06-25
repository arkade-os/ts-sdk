import { describe, expect, it, vi } from "vitest";

vi.mock("light-bolt11-decoder", () => ({
    default: {
        decode: () => ({
            expiry: 3600,
            sections: [
                { name: "amount", value: "9007199254741999" },
                { name: "description", value: "large invoice" },
                { name: "description_hash", value: "a".repeat(64) },
                { name: "payment_hash", value: "hash" },
            ],
        }),
    },
}));

const { decodeInvoice } = await import("../src/utils/decoding");

describe("decodeInvoice", () => {
    it("converts millisats to sats without Number precision loss", () => {
        expect(decodeInvoice("lnbc1mock").amountSats).toBe(9007199254741);
    });

    it("surfaces the description_hash (BOLT11 h) section", () => {
        expect(decodeInvoice("lnbc1mock").descriptionHash).toBe("a".repeat(64));
    });
});
