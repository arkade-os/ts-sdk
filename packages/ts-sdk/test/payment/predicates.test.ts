import { describe, it, expect } from "vitest";
import { ArkAddress } from "../../src";
import {
    isArkAddress,
    isBtcAddress,
    isLightningInvoice,
    isLnurl,
} from "../../src/payment/predicates";

const arkAddr = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).encode();

describe("payment predicates", () => {
    it("isArkAddress decodes ark addresses, rejects others", () => {
        expect(isArkAddress(arkAddr)).toBe(true);
        expect(isArkAddress("bcrt1qexample")).toBe(false);
    });
    it("isBtcAddress matches segwit/legacy, rejects ark", () => {
        expect(isBtcAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080")).toBe(true);
        expect(isBtcAddress(arkAddr)).toBe(false);
    });
    it("isLightningInvoice matches bolt11 prefixes (strips lightning:)", () => {
        expect(isLightningInvoice("lnbc10n1pjexample")).toBe(true);
        expect(isLightningInvoice("lightning:lnbc10n1pjexample")).toBe(true);
        expect(isLightningInvoice("bcrt1qexample")).toBe(false);
    });
    it("isLnurl matches lnurl + lightning-address, rejects bolt11", () => {
        expect(isLnurl("lnurl1dp68gurn8ghj7")).toBe(true);
        expect(isLnurl("alice@arkade.sh")).toBe(true);
        expect(isLnurl("lnbc10n1pj")).toBe(false);
    });
});
