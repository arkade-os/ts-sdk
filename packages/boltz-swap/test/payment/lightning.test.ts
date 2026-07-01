import { describe, it, expect, vi } from "vitest";
import type { RouterContext } from "@arkade-os/sdk";
import { lightningRail } from "../../src/payment/lightning";

const ctx = (swaps: unknown): RouterContext => ({ wallet: {} as any, swaps, prefs: {} });

describe("lightningRail", () => {
    it("matches a bolt11 invoice and the lightning= param of a BIP21 URI", () => {
        const r = lightningRail();
        expect(r.match("lnbc10n1pjexample", ctx({}))).toBe(true);
        expect(r.match("bitcoin:bcrt1qexample?lightning=lnbc10n1pjexample", ctx({}))).toBe(true);
        expect(r.match("bcrt1qexample", ctx({}))).toBe(false);
    });

    it("is unavailable until swaps are configured in the context", async () => {
        const r = lightningRail();
        expect(await r.available?.(ctx(undefined))).toBe(false);
        expect(await r.available?.(ctx({}))).toBe(true);
    });

    it("send() pays the invoice via sendLightningPayment and surfaces the preimage", async () => {
        const sendLightningPayment = vi
            .fn()
            .mockResolvedValue({ amount: 1000, preimage: "pre", txid: "txID" });
        const q = await lightningRail().quote(
            "lnbc10n1pjexample",
            undefined,
            ctx({ sendLightningPayment }),
        );
        const h = await q.send();
        expect(await h.settled()).toMatchObject({
            railId: "lightning",
            preimage: "pre",
            txid: "txID",
        });
        expect(sendLightningPayment).toHaveBeenCalledWith({
            invoice: "lnbc10n1pjexample",
            waitFor: "settled",
        });
    });
});
