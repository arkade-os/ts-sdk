import { describe, it, expect, vi } from "vitest";
import { Ramps } from "../src/wallet/ramps";

const BOARDING_ADDR = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const ARK_ADDR =
    "tark1qqellv77udfmr20tun8dvju5vgudpf9vxe8jwhthrkn26fz96pawqfdy8nk05rsmrf8h94j26905e7n6sng8y059z8ykn2j5xcuw4xt846qj6x";

const utxo = (fill: string, value: number) => ({ txid: fill.repeat(32), vout: 0, value });

const wallet = (over: Record<string, unknown> = {}) =>
    ({
        dustAmount: 330n,
        getBoardingUtxos: vi.fn().mockResolvedValue([utxo("11", 100_000)]),
        getAddress: vi.fn().mockResolvedValue(ARK_ADDR),
        getBoardingAddress: vi.fn().mockResolvedValue(BOARDING_ADDR),
        settle: vi.fn().mockResolvedValue("txSETTLE"),
        ...over,
    }) as any;

describe("Ramps.onboard pays for the change it creates", () => {
    // 7 per input, 100 for the onboarded vtxo, 50 for the boarding change.
    const priced = {
        intentFee: { onchainInput: "7.0", offchainOutput: "100.0", onchainOutput: "50.0" },
    } as any;

    it("funds the change output's own fee, so the settlement balances", async () => {
        const w = wallet();

        await new Ramps(w).onboard(priced, undefined, 50_000n);

        const { inputs, outputs } = w.settle.mock.calls[0]![0];
        expect(outputs).toEqual([
            { address: ARK_ADDR, amount: 49_900n },
            { address: BOARDING_ADDR, amount: 49_943n },
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

    it("leaves a full onboard alone — no change output means no change fee", async () => {
        const w = wallet();

        await new Ramps(w).onboard(priced);

        expect(w.settle.mock.calls[0]![0].outputs).toEqual([
            { address: ARK_ADDR, amount: 99_893n },
        ]);
    });

    it("refuses a change fee that never settles, instead of underfunding the onboard", async () => {
        const absurd = { intentFee: { onchainOutput: "amount" } } as any;
        const w = wallet();

        await expect(new Ramps(w).onboard(absurd, undefined, 50_000n)).rejects.toThrow(
            /change fee/i,
        );
        expect(w.settle).not.toHaveBeenCalled();
    });

    it("emits no change when the fee outruns it, rather than refusing", async () => {
        const steep = { intentFee: { onchainOutput: "100000.0" } } as any;
        const w = wallet();

        await new Ramps(w).onboard(steep, undefined, 50_000n);

        expect(w.settle.mock.calls[0]![0].outputs).toEqual([
            { address: ARK_ADDR, amount: 50_000n },
        ]);
    });
});
