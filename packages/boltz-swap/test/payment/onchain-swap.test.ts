import { describe, it, expect, vi } from "vitest";
import type { RouterContext } from "@arkade-os/sdk";
import { onchainSwapRail } from "../../src/payment/onchain-swap";

const btcAddr = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7k";
const ctx = (swaps: unknown, wallet: unknown = {}): RouterContext => ({
    wallet: wallet as any,
    swaps,
    prefs: {},
});

describe("onchainSwapRail", () => {
    it("matches a BTC address and the on-chain part of a BIP21 URI", () => {
        const r = onchainSwapRail();
        expect(r.match({ raw: btcAddr }, ctx({}))).toBe(true);
        expect(r.match({ raw: `bitcoin:${btcAddr}?lightning=lnbc10n1pj` }, ctx({}))).toBe(true);
        expect(r.match({ raw: "lnbc10n1pjexample" }, ctx({}))).toBe(false);
    });

    it("is unavailable until swaps are configured in the context", async () => {
        expect(await onchainSwapRail().available?.({ raw: btcAddr }, ctx(undefined))).toBe(false);
        expect(await onchainSwapRail().available?.({ raw: btcAddr }, ctx({}))).toBe(true);
    });

    it("send() creates the chain swap, funds the lockup, then claims BTC", async () => {
        const pendingSwap = { id: "swap1" };
        const arkToBtc = vi
            .fn()
            .mockResolvedValue({ arkAddress: "ark1lockup", amountToPay: 1100, pendingSwap });
        const waitAndClaimBtc = vi.fn().mockResolvedValue({ txid: "btcTx" });
        const send = vi.fn().mockResolvedValue("fundTx");

        const q = await onchainSwapRail().quote(
            { raw: btcAddr, amount: 1000 },
            ctx({ arkToBtc, waitAndClaimBtc }, { send }),
        );
        expect(q.amount).toBe(1000);
        const h = await q.send();

        expect(await h.settled()).toMatchObject({
            railId: "onchain-swap",
            txid: "btcTx",
            swapId: "swap1",
        });
        expect(arkToBtc).toHaveBeenCalledWith({ btcAddress: btcAddr, receiverLockAmount: 1000 });
        expect(send).toHaveBeenCalledWith({ address: "ark1lockup", amount: 1100 });
        expect(waitAndClaimBtc).toHaveBeenCalledWith(pendingSwap);
    });

    it("rejects a missing, zero, or fractional amount at quote time", async () => {
        await expect(onchainSwapRail().quote({ raw: btcAddr }, ctx({}))).rejects.toThrow(
            /amount is required/i,
        );
        await expect(onchainSwapRail().quote({ raw: btcAddr, amount: 0 }, ctx({}))).rejects.toThrow(
            /invalid amount/i,
        );
        await expect(
            onchainSwapRail().quote({ raw: btcAddr, amount: 1.5 }, ctx({})),
        ).rejects.toThrow(/invalid amount/i);
    });
});
