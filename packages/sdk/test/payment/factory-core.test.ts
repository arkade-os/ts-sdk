import { describe, it, expect, vi } from "vitest";
import { ArkAddress } from "../../src";
import { createDefaultPaymentRouter } from "../../src/payment";

const arkAddr = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).encode();
const btcAddr = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";

// The onchain rail prices the offboard at quote time, so it needs fee info.
const wallet = () =>
    ({
        arkProvider: {
            getInfo: vi.fn().mockResolvedValue({ fees: { intentFee: {}, txFeeRate: "1" } }),
        },
    }) as any;

describe("createDefaultPaymentRouter(wallet)", () => {
    it("registers ark + onchain rails, ranked by the default priority", async () => {
        const router = createDefaultPaymentRouter(wallet());
        const opts = await router.options({ raw: `bitcoin:${btcAddr}?ark=${arkAddr}` });
        expect(opts.map((o) => o.railId)).toEqual(["ark", "onchain"]);
    });

    it("routes a bare ark address to ark and a bare BTC address to onchain", async () => {
        const router = createDefaultPaymentRouter(wallet());
        expect((await router.route({ raw: arkAddr, amount: 500 })).railId).toBe("ark");
        expect((await router.route({ raw: btcAddr, amount: 500 })).railId).toBe("onchain");
    });
});
