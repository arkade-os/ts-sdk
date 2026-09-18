import { describe, it, expect, vi } from "vitest";
import { Ramps, DustChangeError } from "../src/wallet/ramps";

const BTC_ADDR = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const ARK_ADDR =
    "tark1qqellv77udfmr20tun8dvju5vgudpf9vxe8jwhthrkn26fz96pawqfdy8nk05rsmrf8h94j26905e7n6sng8y059z8ykn2j5xcuw4xt846qj6x";

const fees = { intentFee: {}, txFeeRate: "1" } as any;

const vtxo = (fill: string, value: number) => ({
    txid: fill.repeat(32),
    vout: 0,
    value,
    createdAt: new Date("2026-01-01T00:00:00Z"),
});

const wallet = (over: Record<string, unknown> = {}) =>
    ({
        dustAmount: 330n,
        getSpendableVtxos: vi.fn().mockResolvedValue([vtxo("11", 10_000), vtxo("22", 20_000)]),
        getAddress: vi.fn().mockResolvedValue(ARK_ADDR),
        settle: vi.fn().mockResolvedValue("txSETTLE"),
        logUngatedInputs: vi.fn().mockResolvedValue(undefined),
        ...over,
    }) as any;

describe("Ramps.offboard with a named input set", () => {
    it("spends exactly those inputs, without reading the spendable set", async () => {
        const w = wallet();
        const chosen = [vtxo("33", 50_000)];

        await new Ramps(w).offboard(BTC_ADDR, fees, 5_000n, undefined, chosen as any);

        expect(w.getSpendableVtxos).not.toHaveBeenCalled();
        expect(w.settle).toHaveBeenCalledWith(
            {
                inputs: chosen,
                outputs: [
                    { address: BTC_ADDR, amount: 5_000n },
                    { address: ARK_ADDR, amount: 45_000n },
                ],
            },
            undefined,
        );
    });

    it("still sweeps every spendable VTXO when none are named", async () => {
        const w = wallet();

        await new Ramps(w).offboard(BTC_ADDR, fees, 5_000n);

        expect(w.getSpendableVtxos).toHaveBeenCalledWith({
            withRecoverable: true,
            withUnrolled: false,
        });
        expect(w.settle.mock.calls[0][0].inputs).toHaveLength(2);
    });

    it("drains the named set exactly, with no change output", async () => {
        const w = wallet();

        await new Ramps(w).offboard(BTC_ADDR, fees, 50_000n, undefined, [
            vtxo("33", 50_000),
        ] as any);

        expect(w.settle.mock.calls[0][0].outputs).toEqual([{ address: BTC_ADDR, amount: 50_000n }]);
    });

    it("still refuses a sub-dust change on the named set", async () => {
        const w = wallet();

        await expect(
            new Ramps(w).offboard(BTC_ADDR, fees, 49_900n, undefined, [vtxo("33", 50_000)] as any),
        ).rejects.toThrow(DustChangeError);
        expect(w.settle).not.toHaveBeenCalled();
    });

    it("refuses an amount the named set cannot cover, without topping up", async () => {
        const w = wallet({
            getSpendableVtxos: vi.fn().mockResolvedValue([vtxo("99", 500_000)]),
        });

        await expect(
            new Ramps(w).offboard(BTC_ADDR, fees, 60_000n, undefined, [vtxo("33", 50_000)] as any),
        ).rejects.toThrow(/greater than total amount/i);
        expect(w.settle).not.toHaveBeenCalled();
    });

    it("reports the ungated crossing, as the other explicit-input APIs do", async () => {
        const w = wallet();
        const chosen = [vtxo("33", 50_000)];

        await new Ramps(w).offboard(BTC_ADDR, fees, 5_000n, undefined, chosen as any);

        expect(w.logUngatedInputs).toHaveBeenCalledWith("Ramps.offboard({ vtxos })", chosen);
    });

    it("does not report a crossing when it selected the coins itself", async () => {
        const w = wallet();

        await new Ramps(w).offboard(BTC_ADDR, fees, 5_000n);

        expect(w.logUngatedInputs).not.toHaveBeenCalled();
    });
});
