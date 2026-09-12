import { describe, expect, it } from "vitest";

import { BIP21 } from "../src/utils/bip21";

describe("BIP21", () => {
    it("parses valid amount values", () => {
        const result = BIP21.parse("bitcoin:bc1qexample?amount=1.25");

        expect(result.params.amount).toBe(1.25);
    });

    it("parses amounts with digits omitted on either side of the decimal", () => {
        expect(BIP21.parse("bitcoin:bc1qexample?amount=.5").params.amount).toBe(0.5);
        expect(BIP21.parse("bitcoin:bc1qexample?amount=5.").params.amount).toBe(5);
    });

    it("ignores malformed amount values", () => {
        const result = BIP21.parse("bitcoin:bc1qexample?amount=1abc");

        expect(result.params.amount).toBeUndefined();
    });

    it("ignores unsafe amount values", () => {
        const result = BIP21.parse("bitcoin:bc1qexample?amount=9007199254740992");

        expect(result.params.amount).toBeUndefined();
    });

    it("omits unsafe amount values when creating a URI", () => {
        const uri = BIP21.create({ address: "bc1qexample", amount: Number.MAX_SAFE_INTEGER + 1 });

        expect(uri).toBe("bitcoin:bc1qexample");
    });

    describe("case", () => {
        // Base58 is case-SENSITIVE. Lowercasing produced a DIFFERENT address,
        // and silently: `isBtcAddress` admits a lowercase base58 string, so the
        // corrupted one classified fine and whatever it decoded to got funded.
        const BASE58 = "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn";

        it("parses a base58 address verbatim", () => {
            expect(BIP21.parse(`bitcoin:${BASE58}`).params.address).toBe(BASE58);
        });

        it("creates a URI with a base58 address verbatim", () => {
            expect(BIP21.create({ address: BASE58 })).toBe(`bitcoin:${BASE58}`);
        });

        it("keeps an all-upper bech32 address, which BIP173 permits", () => {
            const upper = "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4";
            expect(BIP21.parse(`bitcoin:${upper}`).params.address).toBe(upper);
        });

        it("keeps an upper-case `ark=` param, which `arkTarget` claims bare", () => {
            // Bech32m forbids a case MIX, not upper case, and
            // `ArkAddress.decode` accepts an all-upper address — so a
            // case-sensitive filter dropped, with a `console.warn`, an address
            // the bare classifier claims happily.
            const upper = "TARK1QZ4EXAMPLE";
            expect(BIP21.parse(`bitcoin:?ark=${upper}`).params.ark).toBe(upper);
            expect(BIP21.create({ ark: upper })).toBe(`bitcoin:?ark=${encodeURIComponent(upper)}`);
        });

        it("still drops a param that is no Arkade address at all", () => {
            expect(BIP21.parse("bitcoin:?ark=nope").params.ark).toBeUndefined();
        });

        it("drops a mixed-case `ark=` param, which Bech32m forbids", () => {
            // Bech32m (BIP350) forbids a case mix.
            expect(BIP21.parse("bitcoin:?ark=ArK1QZ4EXAMPLE").params.ark).toBeUndefined();
            expect(BIP21.create({ ark: "ArK1QZ4EXAMPLE" })).toBe("bitcoin:");
        });
    });
});
