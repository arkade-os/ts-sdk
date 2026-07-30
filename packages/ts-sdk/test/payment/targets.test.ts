import { describe, it, expect } from "vitest";
import { ArkAddress } from "../../src";
import { arkTarget, btcTarget, invoiceTarget } from "../../src/payment/targets";

const arkAddr = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).encode();
const btcAddr = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7k";
const invoice = "lnbc10n1pjexample";
const unified = `bitcoin:${btcAddr}?ark=${arkAddr}&lightning=${invoice}`;

describe("payment targets", () => {
    it("extracts each rail's target from a unified BIP21 URI", () => {
        expect(arkTarget(unified)).toBe(arkAddr);
        expect(btcTarget(unified)).toBe(btcAddr);
        expect(invoiceTarget(unified)).toBe(invoice);
    });

    it("extracts a bare target and ignores foreign ones", () => {
        expect(arkTarget(arkAddr)).toBe(arkAddr);
        expect(btcTarget(btcAddr)).toBe(btcAddr);
        expect(invoiceTarget(invoice)).toBe(invoice);

        expect(arkTarget(btcAddr)).toBeUndefined();
        expect(btcTarget(invoice)).toBeUndefined();
        expect(invoiceTarget(arkAddr)).toBeUndefined();
    });

    it("strips the lightning: prefix, bare or in a URI", () => {
        expect(invoiceTarget(`lightning:${invoice}`)).toBe(invoice);
        expect(invoiceTarget(`bitcoin:${btcAddr}?lightning=lightning:${invoice}`)).toBe(invoice);
    });

    it("rejects a URI whose field holds a target of the wrong kind", () => {
        expect(arkTarget(`bitcoin:${btcAddr}?ark=${invoice}`)).toBeUndefined();
        expect(invoiceTarget(`bitcoin:${btcAddr}?lightning=${arkAddr}`)).toBeUndefined();
    });
});
