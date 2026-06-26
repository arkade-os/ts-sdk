import { describe, it, expect } from "vitest";
import { ArkAddress } from "@arkade-os/sdk";
import { createDefaultPaymentRouter } from "../../src/payment";

const arkAddr = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).encode();
const btcAddr = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7k";

describe("createDefaultPaymentRouter(wallet, swaps)", () => {
    it("fans a unified BIP21 URI out across all four rails, ranked by priority", async () => {
        const router = createDefaultPaymentRouter({} as any, {} as any);
        const opts = await router.options(`bitcoin:${btcAddr}?ark=${arkAddr}&lightning=lnbc10n1pj`);
        expect(opts.map((o) => o.railId)).toEqual(["ark", "lightning", "onchain", "onchain-swap"]);
    });

    it("routes a bare bolt11 invoice to the lightning rail", async () => {
        const router = createDefaultPaymentRouter({} as any, {} as any);
        expect((await router.route("lnbc10n1pjexample")).railId).toBe("lightning");
    });

    it("is re-exported from the boltz-swap package root", async () => {
        const mod = await import("../../src/index");
        expect(typeof mod.createDefaultPaymentRouter).toBe("function");
    });
});
