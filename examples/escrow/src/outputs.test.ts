import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DUST, cancelOutputs, completeOutputs, unilateralOutputs } from "./outputs.ts";

const seller = new Uint8Array([1]);
const buyer = new Uint8Array([2]);

describe("completeOutputs", () => {
    it("pays the seller the whole coin when the surplus is dust", () => {
        const amount = 10_000n;
        const outputs = completeOutputs(amount + DUST, amount, seller, buyer);
        assert.deepEqual(outputs, [{ script: seller, amount: amount + DUST }]);
    });

    it("returns a surplus above dust to the buyer", () => {
        const amount = 10_000n;
        const outputs = completeOutputs(amount + DUST + 1n, amount, seller, buyer);
        assert.deepEqual(outputs, [
            { script: seller, amount },
            { script: buyer, amount: DUST + 1n },
        ]);
    });

    it("refuses a coin below the committed amount", () => {
        assert.throws(() => completeOutputs(999n, 1000n, seller, buyer), /complete pays 1000/);
    });
});

describe("the other paths", () => {
    it("refunds the buyer and exits to the seller", () => {
        assert.deepEqual(cancelOutputs(50n, buyer), [{ script: buyer, amount: 50n }]);
        assert.deepEqual(unilateralOutputs(50n, seller), [{ script: seller, amount: 50n }]);
    });
});
