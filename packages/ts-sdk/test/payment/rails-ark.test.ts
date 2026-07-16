import { describe, it, expect, vi } from "vitest";
import { ArkAddress } from "../../src";
import { arkRail } from "../../src/payment/rails/ark";
import type { RouterContext } from "../../src/payment/types";

const arkAddr = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).encode();
const ctx = (send: any = vi.fn()): RouterContext => ({
    wallet: { send } as any,
    prefs: {},
});

describe("arkRail", () => {
    it("matches a bare ark address and the ark= param of a BIP21 URI", () => {
        const r = arkRail();
        expect(r.match(arkAddr, ctx())).toBe(true);
        expect(r.match(`bitcoin:bcrt1qexample?ark=${arkAddr}`, ctx())).toBe(true);
    });

    it("does not match an on-chain address or a bolt11 invoice", () => {
        const r = arkRail();
        expect(r.match("bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7k", ctx())).toBe(false);
        expect(r.match("lnbc10n1pjexample", ctx())).toBe(false);
    });

    it("quote.send() calls wallet.send and settles with a txid result", async () => {
        const send = vi.fn().mockResolvedValue("txABC");
        const q = await arkRail().quote(arkAddr, 1000, ctx(send));
        expect(q.amount).toBe(1000);
        const h = await q.send();
        expect(await h.settled()).toMatchObject({ railId: "ark", txid: "txABC" });
        expect(send).toHaveBeenCalledWith({ address: arkAddr, amount: 1000 });
    });

    it("falls back to the BIP21-encoded amount (BTC) converted to sats", async () => {
        const send = vi.fn().mockResolvedValue("tx");
        const q = await arkRail().quote(
            `bitcoin:?ark=${arkAddr}&amount=0.0001`,
            undefined,
            ctx(send),
        );
        expect(q.amount).toBe(10000);
        await q.send();
        expect(send).toHaveBeenCalledWith({ address: arkAddr, amount: 10000 });
    });

    it("rejects a missing, zero, or fractional amount at quote time", async () => {
        await expect(arkRail().quote(arkAddr, undefined, ctx())).rejects.toThrow(
            /amount is required/i,
        );
        await expect(arkRail().quote(arkAddr, 0, ctx())).rejects.toThrow(/invalid amount/i);
        await expect(arkRail().quote(arkAddr, 1.5, ctx())).rejects.toThrow(/invalid amount/i);
    });
});
