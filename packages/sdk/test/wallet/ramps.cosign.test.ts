import { describe, it, expect, vi } from "vitest";
import { Ramps } from "../../src/wallet/ramps";
import { OnchainCosignPreflightError } from "../../src/contracts/onchainSpend";
import { OnchainCosignUnsupportedError } from "../../src/providers/ark";

const DEST = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const ARK_ADDR =
    "tark1qqellv77udfmr20tun8dvju5vgudpf9vxe8jwhthrkn26fz96pawqfdy8nk05rsmrf8h94j26905e7n6sng8y059z8ykn2j5xcuw4xt846qj6x";
const fees = { intentFee: {}, txFeeRate: "1" } as any;
const vtxo = {
    txid: "11".repeat(32),
    vout: 0,
    value: 50_000,
    createdAt: new Date("2026-01-01T00:00:00Z"),
};

const wallet = (sendOnchain?: unknown) =>
    ({
        dustAmount: 330n,
        getSpendableVtxos: vi.fn().mockResolvedValue([vtxo]),
        getAddress: vi.fn().mockResolvedValue(ARK_ADDR),
        settle: vi.fn().mockResolvedValue("txSETTLE"),
        logUngatedInputs: vi.fn().mockResolvedValue(undefined),
        ...(sendOnchain ? { sendOnchain } : {}),
    }) as any;

const expectCosigned = (w: any, txid: unknown) => {
    expect(txid).toBe("txONCHAIN");
    expect(w.sendOnchain).toHaveBeenCalledWith({ outputs: [{ address: DEST, amount: 5_000 }] });
    expect(w.settle).not.toHaveBeenCalled();
};

const run = (r: Ramps) =>
    r.offboardExact({ destinationAddress: DEST, feeInfo: fees, amount: 5_000n });

describe("Ramps.offboardExact cosign path", () => {
    it("spends onchain coins in one cosigned tx and skips settle", async () => {
        const w = wallet(vi.fn().mockResolvedValue("txONCHAIN"));
        expectCosigned(w, await run(new Ramps(w)));
    });

    it("falls back to settle when onchain funds are insufficient", async () => {
        const w = wallet(vi.fn().mockRejectedValue(new OnchainCosignPreflightError("short")));
        expect(await run(new Ramps(w))).toBe("txSETTLE");
        expect(w.settle).toHaveBeenCalledTimes(1);
    });

    it("falls back to settle when arkd lacks the endpoint", async () => {
        const w = wallet(vi.fn().mockRejectedValue(new OnchainCosignUnsupportedError()));
        expect(await run(new Ramps(w))).toBe("txSETTLE");
    });

    it("rethrows a non-fallback error", async () => {
        const w = wallet(vi.fn().mockRejectedValue(new Error("boom")));
        await expect(run(new Ramps(w))).rejects.toThrow("boom");
        expect(w.settle).not.toHaveBeenCalled();
    });
});

describe("Ramps cosign path is skipped", () => {
    it("by offboard, whose amount is net of the exit fee", async () => {
        const w = wallet(vi.fn());
        await new Ramps(w).offboard(DEST, fees, 5_000n);
        expect(w.sendOnchain).not.toHaveBeenCalled();
        expect(w.settle).toHaveBeenCalledTimes(1);
    });

    it("by offboardExact when VTXO inputs are named", async () => {
        const w = wallet(vi.fn());
        await new Ramps(w).offboardExact({
            destinationAddress: DEST,
            feeInfo: fees,
            amount: 5_000n,
            vtxos: [vtxo] as any,
        });
        expect(w.sendOnchain).not.toHaveBeenCalled();
        expect(w.settle).toHaveBeenCalledTimes(1);
    });
});
