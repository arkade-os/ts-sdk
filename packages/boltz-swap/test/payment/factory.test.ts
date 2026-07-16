import { describe, it, expect } from "vitest";
import { ArkAddress } from "@arkade-os/sdk";
import { createDefaultPaymentRouter } from "../../src/payment";

const arkAddr = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).encode();
const btcAddr = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7k";
// BOLT11 spec example — decodes to 250_000 sats.
const INVOICE =
    "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7en" +
    "xv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j2" +
    "5emudupq63nyw24cg27h2rspfj9srp";

describe("createDefaultPaymentRouter(wallet, swaps)", () => {
    it("fans a unified BIP21 URI out across all four rails, ranked by priority", async () => {
        const router = createDefaultPaymentRouter({} as any, {} as any);
        const opts = await router.options({
            raw: `bitcoin:${btcAddr}?ark=${arkAddr}&lightning=lnbc10n1pj`,
        });
        expect(opts.map((o) => o.railId)).toEqual(["ark", "lightning", "onchain-swap", "onchain"]);
    });

    it("routes a bare bolt11 invoice to the lightning rail", async () => {
        const router = createDefaultPaymentRouter({} as any, {} as any);
        expect((await router.route({ raw: INVOICE })).railId).toBe("lightning");
    });

    it("prefers the chain swap for a bare BTC address (ark -> btc default)", async () => {
        const router = createDefaultPaymentRouter({} as any, {} as any);
        expect((await router.route({ raw: btcAddr, amount: 1000 })).railId).toBe("onchain-swap");
    });

    it("keeps collaborative exit selectable — preference, not restriction", async () => {
        const router = createDefaultPaymentRouter({} as any, {} as any);
        // both on-chain rails are surfaced, chain swap ranked first
        const opts = await router.options({ raw: btcAddr });
        expect(opts.map((o) => o.railId)).toEqual(["onchain-swap", "onchain"]);
        // an app/user can override the default to force the collaborative exit
        expect(
            (await router.route({ raw: btcAddr, amount: 1000 }, { priority: ["onchain"] })).railId,
        ).toBe("onchain");
    });
});
