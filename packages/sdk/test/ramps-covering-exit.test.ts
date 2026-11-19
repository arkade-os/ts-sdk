import { describe, expect, it, vi } from "vitest";
import { DustChangeError, Ramps } from "../src/wallet/ramps";
import { isSdkPicked } from "../src/wallet/utils";

const BTC_ADDR = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const ARK_ADDR =
    "tark1qqellv77udfmr20tun8dvju5vgudpf9vxe8jwhthrkn26fz96pawqfdy8nk05rsmrf8h94j26905e7n6sng8y059z8ykn2j5xcuw4xt846qj6x";
const fees = { intentFee: {}, txFeeRate: "1" } as any;
const HOUR = 3_600_000;
const NOW = Date.now();

const coin = (fill: string, value: number, hours?: number) => ({
    txid: fill.repeat(32),
    vout: 0,
    value,
    createdAt: new Date(NOW),
    ...(hours === undefined ? {} : { expiresAt: new Date(NOW + hours * HOUR) }),
});

const wallet = (coins: ReturnType<typeof coin>[], over: Record<string, unknown> = {}) =>
    ({
        concurrentSpending: true,
        dustAmount: 330n,
        getSpendableVtxos: vi.fn().mockResolvedValue(coins),
        getAddress: vi.fn().mockResolvedValue(ARK_ADDR),
        settle: vi.fn().mockResolvedValue("txSETTLE"),
        logUngatedInputs: vi.fn().mockResolvedValue(undefined),
        ...over,
    }) as any;

// What a worker-bus round trip leaves of a VtxoReservedError: a plain Error with its name.
const lostRace = () => Object.assign(new Error("taken"), { name: "VtxoReservedError" });
const inputsOf = (w: any, call = 0) =>
    w.settle.mock.calls[call][0].inputs.map((v: { txid: string }) => v.txid.slice(0, 2));
const exact = (w: any, amount: bigint, extra: Record<string, unknown> = {}) =>
    new Ramps(w).offboardExact({ destinationAddress: BTC_ADDR, feeInfo: fees, amount, ...extra });

describe("Ramps exits with concurrentSpending", () => {
    it("spend only the soonest-expiring coins that cover the amount", async () => {
        const w = wallet([coin("aa", 50_000, 30), coin("bb", 50_000, 10), coin("cc", 50_000, 20)]);
        await exact(w, 30_000n);
        expect(inputsOf(w)).toEqual(["bb"]);
        expect(w.settle.mock.calls[0][0].outputs).toEqual([
            { address: BTC_ADDR, amount: 30_000n },
            { address: ARK_ADDR, amount: 20_000n },
        ]);
    });

    it("cover offboard(amount) the same way", async () => {
        const w = wallet([coin("aa", 50_000, 30), coin("bb", 50_000, 10)]);
        await new Ramps(w).offboard(BTC_ADDR, fees, 30_000n);
        expect(inputsOf(w)).toEqual(["bb"]);
    });

    it("rank coins without an expiry last", async () => {
        const w = wallet([coin("aa", 90_000), coin("bb", 40_000, 10)]);
        await exact(w, 30_000n);
        expect(inputsOf(w)).toEqual(["bb"]);
    });

    it("leave no change output on an exact cover", async () => {
        const w = wallet([coin("aa", 30_000, 10), coin("bb", 50_000, 20)]);
        await exact(w, 30_000n);
        expect(inputsOf(w)).toEqual(["aa"]);
        expect(w.settle.mock.calls[0][0].outputs).toEqual([{ address: BTC_ADDR, amount: 30_000n }]);
    });

    it("pull one more coin rather than leave dust change", async () => {
        const w = wallet([coin("aa", 10_100, 10), coin("bb", 5_000, 20), coin("cc", 50_000, 30)]);
        await exact(w, 10_000n);
        expect(inputsOf(w)).toEqual(["aa", "bb"]);
    });

    it("still refuse dust change when no coin is left to add", async () => {
        const w = wallet([coin("aa", 10_100, 10)]);
        await expect(exact(w, 10_000n)).rejects.toThrow(DustChangeError);
    });

    it("stop at 50 inputs", async () => {
        const coins = Array.from({ length: 60 }, (_, i) =>
            coin(i.toString(16).padStart(2, "0"), 1_000, 10 + i),
        );
        const w = wallet(coins);
        await expect(exact(w, 55_000n)).rejects.toThrow("more than 50 inputs");
        expect(w.settle).not.toHaveBeenCalled();
    });

    it("pick again after losing a coin to a concurrent spend", async () => {
        const w = wallet([], {
            getSpendableVtxos: vi
                .fn()
                .mockResolvedValueOnce([coin("aa", 50_000, 10), coin("bb", 50_000, 20)])
                .mockResolvedValueOnce([coin("bb", 50_000, 20)]),
            settle: vi.fn().mockRejectedValueOnce(lostRace()).mockResolvedValueOnce("txSETTLE"),
        });
        await expect(exact(w, 30_000n)).resolves.toBe("txSETTLE");
        expect([inputsOf(w, 0), inputsOf(w, 1)]).toEqual([["aa"], ["bb"]]);
    });

    it("give up after three picks", async () => {
        const w = wallet([coin("aa", 50_000, 10)], {
            settle: vi.fn().mockRejectedValue(lostRace()),
        });
        await expect(exact(w, 30_000n)).rejects.toMatchObject({ name: "VtxoReservedError" });
        expect(w.settle).toHaveBeenCalledTimes(3);
    });

    it("never re-pick a caller's named coins", async () => {
        const w = wallet([], { settle: vi.fn().mockRejectedValue(lostRace()) });
        await expect(exact(w, 30_000n, { vtxos: [coin("aa", 50_000, 10)] })).rejects.toMatchObject({
            name: "VtxoReservedError",
        });
        expect(w.settle).toHaveBeenCalledTimes(1);
    });

    it("keep spending every coin without the setting", async () => {
        const w = wallet([coin("aa", 50_000, 30), coin("bb", 50_000, 10)], {
            concurrentSpending: undefined,
        });
        await exact(w, 30_000n);
        expect(inputsOf(w)).toEqual(["aa", "bb"]);
    });

    it("keep a full exit spending every unreserved coin", async () => {
        const w = wallet([coin("aa", 50_000, 30), coin("bb", 50_000, 10)]);
        await new Ramps(w).offboard(BTC_ADDR, fees);
        expect(inputsOf(w)).toEqual(["aa", "bb"]);
    });

    it("tell settle which inputs it picked itself, so a VTXO held since is refused", async () => {
        const w = wallet([coin("aa", 50_000, 10), coin("bb", 50_000, 20)]);
        await exact(w, 30_000n);
        await new Ramps(w).offboard(BTC_ADDR, fees);
        await exact(w, 30_000n, { vtxos: [coin("cc", 50_000, 10)] });
        expect(w.settle.mock.calls.map(([params]: [object]) => isSdkPicked(params))).toEqual([
            true,
            true,
            false,
        ]);
    });
});
