import { describe, it, expect, vi } from "vitest";
import { Ramps, DustChangeError, OversizedChangeError } from "../src/wallet/ramps";

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

    const pricedFees = { intentFee: { offchainInput: "1000.0" }, txFeeRate: "1" } as any;
    const uneconomic = () => vtxo("44", 500);

    it("refuses a named input worth less than it costs to spend", async () => {
        const w = wallet();

        await expect(
            new Ramps(w).offboard(BTC_ADDR, pricedFees, 5_000n, undefined, [
                uneconomic(),
                vtxo("33", 50_000),
            ] as any),
        ).rejects.toThrow(/4{64}:0 costs 1000 sats to spend and is worth 500/);
        expect(w.settle).not.toHaveBeenCalled();
    });

    it("still drops an uneconomic coin silently when it chose the coins itself", async () => {
        const w = wallet({
            getSpendableVtxos: vi.fn().mockResolvedValue([uneconomic(), vtxo("33", 50_000)]),
        });

        await new Ramps(w).offboard(BTC_ADDR, pricedFees, 5_000n);

        expect(w.settle.mock.calls[0][0].inputs).toEqual([vtxo("33", 50_000)]);
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

describe("Ramps.offboard pays for the change it creates", () => {
    // 7 per input, 100 for the exit output, 50 for the change output.
    const priced = {
        intentFee: { offchainInput: "7.0", onchainOutput: "100.0", offchainOutput: "50.0" },
    } as any;

    it("funds the change output's own fee, so the settlement balances", async () => {
        const w = wallet({ getSpendableVtxos: vi.fn().mockResolvedValue([vtxo("11", 100_000)]) });

        await new Ramps(w).offboard(BTC_ADDR, priced, 50_000n);

        const { inputs, outputs } = w.settle.mock.calls[0]![0];
        expect(outputs).toEqual([
            { address: BTC_ADDR, amount: 49_900n },
            { address: ARK_ADDR, amount: 49_943n },
        ]);
        const spent: bigint = inputs.reduce(
            (s: bigint, i: { value: number }) => s + BigInt(i.value),
            0n,
        );
        const claimed: bigint = outputs.reduce(
            (s: bigint, o: { amount: bigint }) => s + o.amount,
            0n,
        );
        expect(spent - claimed).toBe(157n);
    });

    it("leaves a full sweep alone — no change output means no change fee", async () => {
        const w = wallet({ getSpendableVtxos: vi.fn().mockResolvedValue([vtxo("11", 100_000)]) });

        await new Ramps(w).offboard(BTC_ADDR, priced);

        expect(w.settle.mock.calls[0]![0].outputs).toEqual([
            { address: BTC_ADDR, amount: 99_893n },
        ]);
    });

    it("refuses a change fee that never settles, instead of underfunding the exit", async () => {
        // Charging the whole output oscillates change → 0 → change, never reaching a fixpoint.
        const absurd = { intentFee: { offchainOutput: "amount" } } as any;
        const w = wallet({ getSpendableVtxos: vi.fn().mockResolvedValue([vtxo("11", 100_000)]) });

        await expect(new Ramps(w).offboard(BTC_ADDR, absurd, 50_000n)).rejects.toThrow(
            /change fee/i,
        );
        expect(w.settle).not.toHaveBeenCalled();
    });

    it("refuses a super-linear schedule that diverges instead of oscillating", async () => {
        // Overshoots every round, alternating sign — so the refusal cannot depend on the last one's.
        const superLinear = { intentFee: { offchainOutput: "amount * 1.5" } } as any;
        const w = wallet({ getSpendableVtxos: vi.fn().mockResolvedValue([vtxo("11", 100_000)]) });

        await expect(new Ramps(w).offboard(BTC_ADDR, superLinear, 50_000n)).rejects.toThrow(
            /change fee/i,
        );
        expect(w.settle).not.toHaveBeenCalled();
    });

    it("emits no change when a flat fee outruns it, rather than refusing", async () => {
        const steep = { intentFee: { offchainOutput: "100000.0" } } as any;
        const w = wallet({ getSpendableVtxos: vi.fn().mockResolvedValue([vtxo("11", 100_000)]) });

        await new Ramps(w).offboard(BTC_ADDR, steep, 50_000n);

        expect(w.settle.mock.calls[0]![0].outputs).toEqual([
            { address: BTC_ADDR, amount: 50_000n },
        ]);
    });

    it("judges the dust floor on the change that survives the fee", async () => {
        // 50_360 - 7 input - 50_000 = 353 before the fee, 303 after: under the 330 floor.
        const w = wallet({ getSpendableVtxos: vi.fn().mockResolvedValue([vtxo("11", 50_360)]) });

        await expect(new Ramps(w).offboard(BTC_ADDR, priced, 50_000n)).rejects.toThrow(
            DustChangeError,
        );
        expect(w.settle).not.toHaveBeenCalled();
    });
});

const exactExit = (w: any, feeInfo: any, amount: bigint) =>
    new Ramps(w).offboardExact({ destinationAddress: BTC_ADDR, feeInfo, amount });

describe("Ramps.offboardExact pays the destination exactly", () => {
    const one = () =>
        wallet({ getSpendableVtxos: vi.fn().mockResolvedValue([vtxo("11", 100_000)]) });

    it("takes a flat exit fee out of the balance, not out of the recipient's figure", async () => {
        const w = one();

        await exactExit(w, { intentFee: { onchainOutput: "100.0" } }, 50_000n);

        expect(w.settle.mock.calls[0]![0].outputs).toEqual([
            { address: BTC_ADDR, amount: 50_000n },
            { address: ARK_ADDR, amount: 49_900n },
        ]);
    });

    // 1% of the 50_000 the recipient is handed is 500. Deducting from it instead
    // needs `g - fee(g) = 50_000` solved, which lands on 50_505: five sats of
    // change for an output nobody ships.
    it("prices the fee on the destination output, not on a grossed-up amount", async () => {
        const w = one();

        await exactExit(w, { intentFee: { onchainOutput: "amount * 0.01" } }, 50_000n);

        expect(w.settle.mock.calls[0]![0].outputs).toEqual([
            { address: BTC_ADDR, amount: 50_000n },
            { address: ARK_ADDR, amount: 49_500n },
        ]);
    });

    it("still funds the change output's own fee", async () => {
        // 100_000 - 7 input - 50_000 - 500 exit = 49_493, less the change's own 50.
        const w = one();
        const feeInfo = {
            intentFee: {
                offchainInput: "7.0",
                onchainOutput: "amount * 0.01",
                offchainOutput: "50.0",
            },
        };

        await exactExit(w, feeInfo, 50_000n);

        expect(w.settle.mock.calls[0]![0].outputs).toEqual([
            { address: BTC_ADDR, amount: 50_000n },
            { address: ARK_ADDR, amount: 49_443n },
        ]);
    });

    it("refuses an amount the inputs cannot deliver, and a non-positive one", async () => {
        const short = wallet({
            getSpendableVtxos: vi.fn().mockResolvedValue([vtxo("11", 50_000)]),
        });

        await expect(
            exactExit(short, { intentFee: { onchainOutput: "100.0" } }, 50_000n),
        ).rejects.toThrow(/needed to deliver 50000 exactly/);
        await expect(exactExit(wallet(), fees, 0n)).rejects.toThrow(/must be positive/);
        expect(short.settle).not.toHaveBeenCalled();
    });
});

describe("both exits keep the change under the server's per-output ceiling", () => {
    const priced = { intentFee: { onchainOutput: "100.0" } } as any;
    // 100_000 - 30_100 = 69_900 of change.
    const ceiling = (vtxoMaxAmount: bigint) =>
        wallet({
            getSpendableVtxos: vi.fn().mockResolvedValue([vtxo("11", 100_000)]),
            arkProvider: { getInfo: vi.fn().mockResolvedValue({ vtxoMaxAmount }) },
        });

    it("refuses an oversized change on either exit, and settles one that lands on the ceiling", async () => {
        const exact = ceiling(40_000n);
        const plain = ceiling(40_000n);

        await expect(exactExit(exact, priced, 30_000n)).rejects.toThrow(OversizedChangeError);
        await expect(new Ramps(plain).offboard(BTC_ADDR, priced, 30_000n)).rejects.toThrow(
            OversizedChangeError,
        );
        expect(exact.settle).not.toHaveBeenCalled();
        expect(plain.settle).not.toHaveBeenCalled();

        const bounded = ceiling(69_900n);
        await exactExit(bounded, priced, 30_000n);
        expect(bounded.settle.mock.calls[0]![0].outputs).toEqual([
            { address: BTC_ADDR, amount: 30_000n },
            { address: ARK_ADDR, amount: 69_900n },
        ]);
    });

    it("reads `-1` as no ceiling, and a wallet with no provider as none to read", async () => {
        const unlimited = ceiling(-1n);
        await exactExit(unlimited, priced, 30_000n);
        expect(unlimited.settle).toHaveBeenCalledTimes(1);

        const mock = wallet({
            getSpendableVtxos: vi.fn().mockResolvedValue([vtxo("11", 100_000)]),
        });
        await exactExit(mock, priced, 30_000n);
        expect(mock.settle).toHaveBeenCalledTimes(1);
    });
});
