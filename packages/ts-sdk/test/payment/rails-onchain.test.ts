import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ArkAddress } from "../../src";
import { onchainRail } from "../../src/payment/rails/onchain";
import { Ramps } from "../../src/wallet/ramps";
import type { RouterContext } from "../../src/payment/types";

const btcAddr = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7k";
const arkAddr = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).encode();

const fees = { intentFee: {}, txFeeRate: "1" };

const ctx = (wallet: Partial<Record<string, any>>): RouterContext => ({
    wallet: { arkProvider: { getInfo: vi.fn().mockResolvedValue({ fees }) }, ...wallet } as any,
    prefs: {},
});

describe("onchainRail (collaborative exit)", () => {
    let offboard: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        offboard = vi.spyOn(Ramps.prototype, "offboard").mockResolvedValue("txEXIT");
    });
    afterEach(() => {
        offboard.mockRestore();
    });

    it("matches a bare BTC address and the on-chain part of a BIP21 URI", () => {
        const r = onchainRail();
        expect(r.match({ raw: btcAddr }, ctx({}))).toBe(true);
        expect(r.match({ raw: `bitcoin:${btcAddr}?ark=${arkAddr}` }, ctx({}))).toBe(true);
    });

    it("does not match an ark address or a bolt11 invoice", () => {
        const r = onchainRail();
        expect(r.match({ raw: arkAddr }, ctx({}))).toBe(false);
        expect(r.match({ raw: "lnbc10n1pjexample" }, ctx({}))).toBe(false);
    });

    it("offboards the amount to the BTC address and surfaces the txid", async () => {
        const c = ctx({});
        const q = await onchainRail().quote({ raw: btcAddr, amount: 1000 }, c);
        const h = await q.send();

        expect(await h.settled()).toMatchObject({ railId: "onchain", txid: "txEXIT" });
        expect(offboard).toHaveBeenCalledTimes(1);
        expect(offboard).toHaveBeenCalledWith(btcAddr, fees, 1000n);
    });

    it("falls back to the BIP21-encoded amount (BTC) converted to sats", async () => {
        const q = await onchainRail().quote({ raw: `bitcoin:${btcAddr}?amount=0.00001` }, ctx({}));
        expect(q.amount).toBe(1000);
        await q.send().then((h) => h.settled());
        expect(offboard).toHaveBeenCalledWith(btcAddr, fees, 1000n);
    });

    it("rejects a non-positive or fractional amount up front", async () => {
        await expect(onchainRail().quote({ raw: btcAddr, amount: 0 }, ctx({}))).rejects.toThrow(
            /invalid amount/i,
        );
        await expect(onchainRail().quote({ raw: btcAddr, amount: 1.5 }, ctx({}))).rejects.toThrow(
            /invalid amount/i,
        );
    });
});
