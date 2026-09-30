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

    it.each([1, 10, 99, 100, 546, 99_999_999, 100_000_000, 2_100_000_000_000_000])(
        "round-trips %i sat through create and parse",
        (sat) => {
            const uri = BIP21.create({ address: "bc1qexample", amount: sat / 1e8 });

            expect(BIP21.amountSats(uri)).toBe(sat);
        },
    );

    it("writes a sub-microbitcoin amount as a plain decimal", () => {
        expect(BIP21.create({ address: "bc1qexample", amount: 10 / 1e8 })).toBe(
            "bitcoin:bc1qexample?amount=0.0000001",
        );
    });

    it("writes a whole amount without trailing zeros", () => {
        expect(BIP21.create({ address: "bc1qexample", amount: 1 })).toBe(
            "bitcoin:bc1qexample?amount=1",
        );
    });

    it("omits unsafe amount values when creating a URI", () => {
        const uri = BIP21.create({ address: "bc1qexample", amount: Number.MAX_SAFE_INTEGER + 1 });

        expect(uri).toBe("bitcoin:bc1qexample");
    });
});
