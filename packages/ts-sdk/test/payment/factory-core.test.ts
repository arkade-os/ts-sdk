import { describe, it, expect } from "vitest";
import * as sdk from "../../src";
import { ArkAddress } from "../../src";
import { createDefaultPaymentRouter } from "../../src/payment";

const arkAddr = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).encode();
const btcAddr = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7k";

describe("createDefaultPaymentRouter(wallet)", () => {
    it("registers ark + onchain rails, ranked by the default priority", async () => {
        const router = createDefaultPaymentRouter({} as any);
        const opts = await router.options(`bitcoin:${btcAddr}?ark=${arkAddr}`);
        expect(opts.map((o) => o.railId)).toEqual(["ark", "onchain"]);
    });

    it("routes a bare ark address to ark and a bare BTC address to onchain", async () => {
        const router = createDefaultPaymentRouter({} as any);
        expect((await router.route(arkAddr, 500)).railId).toBe("ark");
        expect((await router.route(btcAddr, 500)).railId).toBe("onchain");
    });

    it("is re-exported from the SDK root with PaymentRouter, BIP21 and predicates", () => {
        expect(typeof sdk.createDefaultPaymentRouter).toBe("function");
        expect(typeof sdk.PaymentRouter).toBe("function");
        expect(typeof sdk.BIP21).toBe("function");
        expect(typeof sdk.isArkAddress).toBe("function");
    });
});
