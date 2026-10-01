import { describe, it, expect } from "vitest";
import { ArkAddress } from "../../src";
import {
    isValidArkAddress,
    isBtcAddress,
    isLightningInvoice,
    isLnurl,
} from "../../src/payment/predicates";

const arkAddr = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).encode();

describe("payment predicates", () => {
    it("isValidArkAddress decodes ark addresses, rejects others", () => {
        expect(isValidArkAddress(arkAddr)).toBe(true);
        expect(isValidArkAddress("bcrt1qexample")).toBe(false);
    });
    it("isBtcAddress matches segwit/legacy, rejects ark", () => {
        expect(isBtcAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080")).toBe(true);
        expect(isBtcAddress(arkAddr)).toBe(false);
    });
    it.each([
        ["1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", true],
        ["3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", true],
        // Legacy testnet/regtest — consumers route these on regtest.
        ["mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", true],
        ["n2eMqTT929pb1RDNuqEnxdaLau1rxy3efi", true],
        ["2N2JD6wb56AfK4tfmM6PwdVmoYk2dCKf4Br", true],
        ["tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", true],
        ["BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KYGT080", true],
        // BIP173: mixed case is invalid.
        ["bc1QW508d6qejxtdg4y5r3zarvary0c5xw7kygt080", false],
    ])("isBtcAddress(%s) === %s", (addr, expected) => {
        expect(isBtcAddress(addr as string)).toBe(expected);
    });
    it("isLightningInvoice matches bolt11 prefixes (strips lightning:)", () => {
        expect(isLightningInvoice("lnbc10n1pjexample")).toBe(true);
        expect(isLightningInvoice("lightning:lnbc10n1pjexample")).toBe(true);
        expect(isLightningInvoice("bcrt1qexample")).toBe(false);
    });
    it.each([
        ["lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfq", true], // amount in HRP
        ["lntb30m1pw2f2yspp5s59w4a0kjecw3zyexm7zur8l8n4scw674w", true],
        ["lntbs1pnexample", true], // signet
        ["lnbcrt1pnexample", true], // regtest
        ["lnsb1pnexample", true], // simnet
        ["lnbs1pnexample", false], // not a BOLT11 HRP
        ["lnbc!!!", false],
    ])("isLightningInvoice(%s) === %s", (invoice, expected) => {
        expect(isLightningInvoice(invoice as string)).toBe(expected);
    });
    it("isLnurl matches lnurl + lightning-address, rejects bolt11", () => {
        expect(isLnurl("lnurl1dp68gurn8ghj7")).toBe(true);
        expect(isLnurl("alice@arkade.sh")).toBe(true);
        expect(isLnurl("lnbc10n1pj")).toBe(false);
    });
});
