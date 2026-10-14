import { describe, expect, it } from "vitest";
import { DEFAULT_INVOICE_EXPIRY_SECONDS, decodeBolt11 } from "../../../src/client/corridors/bolt11";
import { encodeInvoice } from "../../helpers/bolt11";

/**
 * A real, published mainnet invoice — `light-bolt11-decoder`'s own fixture.
 * It is what pins the encoder in `test/helpers/bolt11.ts` against reality: the
 * per-HRP vectors below are built, because published invoices exist for
 * mainnet only.
 */
const REAL_MAINNET =
    "lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpq" +
    "d4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k" +
    "77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpy" +
    "w0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm0" +
    "3c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp5" +
    "4l567";

const HASH = "f5636521e98000697a6700b979c288ddad56cb3995a2eb07550872c466ccc3e5";
const TIMESTAMP = 1_700_000_000;

describe("the built-in bolt11 decoder", () => {
    it("decodes a real invoice", () => {
        expect(decodeBolt11(REAL_MAINNET)).toEqual({
            raw: REAL_MAINNET,
            paymentHash: HASH,
            amountSats: 2_000,
            // timestamp 1648859703 plus the `x` tag's 48 hours
            expiresAt: 1_648_859_703 + 172_800,
        });
    });

    it("reports an absolute expiry, where the library's tag is relative", () => {
        const invoice = encodeInvoice({
            prefix: "lnbc",
            amount: "20u",
            timestamp: TIMESTAMP,
            expiry: 600,
            paymentHash: HASH,
        });
        expect(decodeBolt11(invoice).expiresAt).toBe(TIMESTAMP + 600);
    });

    it("applies BOLT11's default expiry when the invoice carries no `x` tag", () => {
        const invoice = encodeInvoice({
            prefix: "lnbc",
            amount: "20u",
            timestamp: TIMESTAMP,
            paymentHash: HASH,
        });
        expect(decodeBolt11(invoice).expiresAt).toBe(TIMESTAMP + DEFAULT_INVOICE_EXPIRY_SECONDS);
        expect(DEFAULT_INVOICE_EXPIRY_SECONDS).toBe(3_600);
    });

    it("converts millisats through bigint, so precision survives past 2^53", () => {
        // 90071992547419990p is 9_007_199_254_741_999 msat — over `Number`'s
        // integer range, where `Number(msat) / 1000` would round before it
        // divided.
        const invoice = encodeInvoice({
            prefix: "lnbc",
            amount: "90071992547419990p",
            timestamp: TIMESTAMP,
            paymentHash: HASH,
        });
        expect(decodeBolt11(invoice).amountSats).toBe(9_007_199_254_741);
    });

    it("reports an amountless invoice as 0, which is how the gates spell it", () => {
        const invoice = encodeInvoice({ prefix: "lnbc", timestamp: TIMESTAMP, paymentHash: HASH });
        expect(decodeBolt11(invoice).amountSats).toBe(0);
    });

    it("carries the payment hash verbatim, lowercase", () => {
        const invoice = encodeInvoice({
            prefix: "lnbcrt",
            amount: "20u",
            timestamp: TIMESTAMP,
            paymentHash: HASH,
        });
        expect(decodeBolt11(invoice).paymentHash).toBe(HASH);
    });

    it("decodes every HRP the network table names", () => {
        for (const prefix of ["lnbc", "lntb", "lntbs", "lnbcrt", "lnsb"]) {
            const invoice = encodeInvoice({
                prefix,
                amount: "20u",
                timestamp: TIMESTAMP,
                paymentHash: HASH,
            });
            // The decoder is network-blind on purpose: the HRP check is the
            // corridor's, so an `lnsb` invoice decodes here and is refused there.
            expect(decodeBolt11(invoice).amountSats).toBe(2_000);
        }
    });

    describe("refusals", () => {
        it("refuses a string that is not an invoice", () => {
            expect(() => decodeBolt11("not-an-invoice")).toThrow();
        });

        it("refuses an invoice whose checksum does not hold", () => {
            const invoice = encodeInvoice({
                prefix: "lnbc",
                amount: "20u",
                timestamp: TIMESTAMP,
                paymentHash: HASH,
            });
            expect(() =>
                decodeBolt11(`${invoice.slice(0, -1)}${invoice.endsWith("q") ? "p" : "q"}`),
            ).toThrow();
        });

        it("refuses an invoice with no payment hash rather than defaulting to an empty one", () => {
            // `?? ""` was the deleted decoder's answer. An empty hash typechecks
            // onto the invoice instrument and is then compared byte-for-byte
            // against a real one.
            const withoutHash = encodeInvoice({
                prefix: "lnbc",
                amount: "20u",
                timestamp: TIMESTAMP,
            });
            expect(() => decodeBolt11(withoutHash)).toThrow(/payment hash/);
        });
    });
});
