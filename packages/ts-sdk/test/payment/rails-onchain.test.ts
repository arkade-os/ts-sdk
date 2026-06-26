import { describe, it, expect, vi } from "vitest";
import { ArkAddress } from "../../src";
import { onchainRail } from "../../src/payment/rails/onchain";
import type { RouterContext } from "../../src/payment/types";

const btcAddr = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7k";
const arkAddr = new ArkAddress(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)).encode();

const vtxo = (value: number, batchExpiry: number, txid: string) =>
    ({ txid, vout: 0, value, virtualStatus: { batchExpiry } }) as any;

const ctx = (wallet: Partial<Record<string, any>>): RouterContext => ({
    wallet: wallet as any,
    prefs: {},
});

describe("onchainRail (collaborative exit)", () => {
    it("matches a bare BTC address and the on-chain part of a BIP21 URI", () => {
        const r = onchainRail();
        expect(r.match(btcAddr, ctx({}))).toBe(true);
        expect(r.match(`bitcoin:${btcAddr}?ark=${arkAddr}`, ctx({}))).toBe(true);
    });

    it("does not match an ark address or a bolt11 invoice", () => {
        const r = onchainRail();
        expect(r.match(arkAddr, ctx({}))).toBe(false);
        expect(r.match("lnbc10n1pjexample", ctx({}))).toBe(false);
    });

    it("selects soonest-expiring VTXOs, settles to the BTC address with change", async () => {
        const a = vtxo(800, 100, "a");
        const b = vtxo(600, 200, "b");
        const c = vtxo(5000, 300, "c"); // bigger, but expires later — must be skipped
        const getVtxos = vi.fn().mockResolvedValue([c, a, b]);
        const getAddress = vi.fn().mockResolvedValue("ark1change");
        const settle = vi.fn().mockResolvedValue("txEXIT");

        const q = await onchainRail().quote(btcAddr, 1000, ctx({ getVtxos, getAddress, settle }));
        const h = await q.send();

        expect(await h.settled()).toMatchObject({ railId: "onchain", txid: "txEXIT" });
        expect(settle).toHaveBeenCalledTimes(1);
        const arg = settle.mock.calls[0][0];
        expect(arg.inputs).toEqual([a, b]); // soonest-expiring first, just enough
        expect(arg.outputs).toContainEqual({ address: btcAddr, amount: 1000n });
        expect(arg.outputs).toContainEqual({ address: "ark1change", amount: 400n });
    });

    it("omits a change output when selection is exact", async () => {
        const settle = vi.fn().mockResolvedValue("tx");
        const getVtxos = vi.fn().mockResolvedValue([vtxo(1000, 100, "a")]);
        const getAddress = vi.fn().mockResolvedValue("ark1change");
        const q = await onchainRail().quote(btcAddr, 1000, ctx({ getVtxos, getAddress, settle }));
        await q.send().then((h) => h.settled());
        expect(settle.mock.calls[0][0].outputs).toEqual([{ address: btcAddr, amount: 1000n }]);
    });

    it("rejects when VTXOs do not cover the amount", async () => {
        const getVtxos = vi.fn().mockResolvedValue([vtxo(500, 100, "a")]);
        const q = await onchainRail().quote(btcAddr, 1000, ctx({ getVtxos }));
        const h = await q.send();
        await expect(h.settled()).rejects.toThrow(/insufficient/i);
    });
});
