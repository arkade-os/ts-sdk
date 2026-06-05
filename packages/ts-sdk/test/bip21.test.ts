import { describe, expect, it } from "vitest";

import { BIP21 } from "../src/utils/bip21";

describe("BIP21", () => {
    it("parses valid amount values", () => {
        const result = BIP21.parse("bitcoin:bc1qexample?amount=1.25");

        expect(result.params.amount).toBe(1.25);
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
});
