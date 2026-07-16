import { describe, it, expect, vi } from "vitest";
import type { RouterContext } from "@arkade-os/sdk";
import { lightningRail } from "../../src/payment/lightning";

const ctx = (swaps: unknown): RouterContext => ({ wallet: {} as any, swaps, prefs: {} });

// BOLT11 spec example — decodes to 250_000 sats (amount = 2500u).
const INVOICE =
    "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7en" +
    "xv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j2" +
    "5emudupq63nyw24cg27h2rspfj9srp";

describe("lightningRail", () => {
    it("matches a bolt11 invoice and the lightning= param of a BIP21 URI", () => {
        const r = lightningRail();
        expect(r.match({ raw: "lnbc10n1pjexample" }, ctx({}))).toBe(true);
        expect(r.match({ raw: "bitcoin:bcrt1qexample?lightning=lnbc10n1pjexample" }, ctx({}))).toBe(
            true,
        );
        expect(r.match({ raw: "bcrt1qexample" }, ctx({}))).toBe(false);
    });

    it("is unavailable until swaps are configured in the context", async () => {
        const r = lightningRail();
        expect(await r.available?.({ raw: INVOICE }, ctx(undefined))).toBe(false);
        expect(await r.available?.({ raw: INVOICE }, ctx({}))).toBe(true);
    });

    it("send() pays the invoice via sendLightningPayment and surfaces the preimage", async () => {
        const sendLightningPayment = vi
            .fn()
            .mockResolvedValue({ amount: 1000, preimage: "pre", txid: "txID" });
        const q = await lightningRail().quote({ raw: INVOICE }, ctx({ sendLightningPayment }));
        expect(q.amount).toBe(250_000);
        const h = await q.send();
        expect(await h.settled()).toMatchObject({
            railId: "lightning",
            preimage: "pre",
            txid: "txID",
        });
        expect(sendLightningPayment).toHaveBeenCalledWith({
            invoice: INVOICE,
            waitFor: "settled",
        });
    });

    it("rejects an amountless / undecodable invoice at quote time", async () => {
        await expect(lightningRail().quote({ raw: "lnbc1invalid" }, ctx({}))).rejects.toThrow(
            /invalid amount/i,
        );
    });
});
