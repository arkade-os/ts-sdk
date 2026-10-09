import { afterEach, describe, expect, it, vi } from "vitest";
import { computeOffchainBalance } from "../src/wallet/balance";
import { fundedWallet, stallSubmits } from "./concurrentSpendingFixture";

afterEach(() => vi.restoreAllMocks());

const key = (v: { txid: string; vout: number }) => `${v.txid}:${v.vout}`;
const thrown = (fn: () => unknown): unknown => {
    try {
        fn();
    } catch (e) {
        return e;
    }
    throw new Error("expected a throw");
};

describe("reserveVtxos", () => {
    it("keeps a held coin out of SDK picks, visible, and spendable by name", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, coins, outpoints } = await fundedWallet({ concurrentSpending: true });
        const hold = wallet.reserveVtxos([coins[0]]);
        expect((await wallet.getSpendableVtxos()).map(key)).not.toContain(outpoints[0]);
        expect((await wallet.getVtxos()).map(key)).toContain(outpoints[0]);

        const submits = stallSubmits(wallet);
        const to = await wallet.getAddress();
        const picked = wallet.send({ address: to, amount: 2_000 });
        await vi.waitFor(() => expect(submits).toHaveLength(1));
        expect(submits[0].inputs).toEqual([outpoints[1]]);
        submits[0].finish();
        await picked;

        const named = wallet.send({
            recipients: [{ address: to, amount: 2_000 }],
            selectedVtxos: [coins[0]],
        });
        await vi.waitFor(() => expect(submits).toHaveLength(2));
        expect(submits[1].inputs).toEqual([outpoints[0]]);
        submits[1].finish();
        await named;
        hold.release();
        await wallet.dispose();
    });

    it("moves held value from available to reserved", async () => {
        const { wallet, coins } = await fundedWallet();
        const before = await wallet.getBalance();
        const hold = wallet.reserveVtxos([coins[0]]);
        const held = await wallet.getBalance();
        expect(held.reserved).toBe(10_000);
        expect(held.available).toBe(before.available - 10_000);
        expect(held.settled + held.preconfirmed).toBe(
            held.available + held.gated + held.intentLocked + held.reserved,
        );
        hold.release();
        hold.release();
        expect((await wallet.getBalance()).reserved).toBe(0);
        await wallet.dispose();
    });

    it("holds all or nothing, once, and never a coin being spent", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, coins, outpoints } = await fundedWallet({ concurrentSpending: true });
        const hold = wallet.reserveVtxos([coins[0]]);
        expect(thrown(() => wallet.reserveVtxos([coins[1], coins[0]]))).toMatchObject({
            name: "VtxoReservedError",
            holder: "held",
            outpoints: [outpoints[0]],
        });
        wallet.reserveVtxos([coins[1]]).release();
        hold.release();

        const submits = stallSubmits(wallet);
        const sending = wallet.send({ address: await wallet.getAddress(), amount: 2_000 });
        await vi.waitFor(() => expect(submits).toHaveLength(1));
        expect(thrown(() => wallet.reserveVtxos([coins[0]]))).toMatchObject({
            holder: "in-flight",
        });
        submits[0].finish();
        await sending;
        await wallet.dispose();
    });

    it("accepts an empty or repeated list", async () => {
        const { wallet, coins } = await fundedWallet();
        wallet.reserveVtxos([]).release();
        const hold = wallet.reserveVtxos([coins[0], coins[0]]);
        expect((await wallet.getBalance()).reserved).toBe(10_000);
        hold.release();
        expect((await wallet.getBalance()).reserved).toBe(0);
        await wallet.dispose();
    });
});

describe("computeOffchainBalance reserved bucket", () => {
    it("counts a coin once, gated before intent-locked before reserved", () => {
        const coin = (fill: string, value: number) =>
            ({
                txid: fill.repeat(32),
                vout: 0,
                value,
                status: { confirmed: true },
                createdAt: new Date(),
                isUnrolled: false,
                isSpent: false,
                isSwept: false,
                isPreconfirmed: false,
                commitmentTxIds: [],
                spentBy: "",
                expiresAt: new Date(Date.now() + 3_600_000),
                script: "51",
            }) as any;
        const [g, l, r, a] = [coin("aa", 1), coin("bb", 10), coin("cc", 100), coin("dd", 1_000)];

        const balance = computeOffchainBalance([g, l, r, a], {
            now: { timestamp: new Date() },
            isPendingRecovery: () => false,
            isGenericallySpendable: (v) => v !== g,
            isUnlocked: (v) => v !== g && v !== l,
            isReserved: (v) => v !== a,
            dustCarrier: 0n,
        });

        expect([balance.gated, balance.intentLocked, balance.reserved, balance.available]).toEqual([
            1, 10, 100, 1_000,
        ]);
    });
});
