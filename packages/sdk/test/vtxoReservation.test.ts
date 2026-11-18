import { afterEach, describe, expect, it, vi } from "vitest";
import { computeOffchainBalance } from "../src/wallet/balance";
import { BTC_ADDR, fundedWallet, stallSubmits } from "./concurrentSpendingFixture";
import { IndexedDBVtxoReservationRepository } from "../src/repositories/indexedDB/vtxoReservationRepository";

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
            held.available + held.contractLocked + held.pendingSettlement + held.reserved,
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

    it("reports what it holds to renewal, which skips it", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, coins, outpoints } = await fundedWallet();
        expect(await (wallet as any).getHeldVtxos()).toEqual([]);
        const hold = wallet.reserveVtxos([coins[0]]);
        expect((await (wallet as any).getHeldVtxos()).map(key)).toEqual([outpoints[0]]);

        // 15h: coins[0] (10h out) is due, but held; coins[1] (20h) and coins[2] (30h) are not.
        const manager = await wallet.getVtxoManager();
        expect(await manager.getExpiringVtxos(15 * 3_600_000)).toEqual([]);
        hold.release();
        expect((await manager.getExpiringVtxos(15 * 3_600_000)).map(key)).toEqual([outpoints[0]]);
        await wallet.dispose();
    });

    it("leaves a held coin out of recovery and recovers the rest", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, coins, outpoints } = await fundedWallet();
        const swept = coins.slice(0, 2).map((coin) => ({ ...coin, isSwept: true }));
        await wallet.walletRepository.saveVtxos(await wallet.getAddress(), swept);
        const hold = wallet.reserveVtxos([coins[0]]);
        const settle = vi.spyOn(wallet, "settle").mockResolvedValue("recovered");
        const manager = await wallet.getVtxoManager();

        expect(await manager.recoverVtxos()).toBe("recovered");
        expect(settle.mock.calls[0][0]!.inputs!.map((input) => key(input as any))).toEqual([
            outpoints[1],
        ]);

        hold.release();
        await wallet.dispose();
    });

    it("refuses a recovery whose every candidate is held, naming the hold", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, coins } = await fundedWallet();
        await wallet.walletRepository.saveVtxos(await wallet.getAddress(), [
            { ...coins[0], isSwept: true },
        ]);
        const hold = wallet.reserveVtxos([coins[0]]);
        const settle = vi.spyOn(wallet, "settle");
        const manager = await wallet.getVtxoManager();

        await expect(manager.recoverVtxos()).rejects.toThrow(/held by reserveVtxos/);
        expect(settle).not.toHaveBeenCalled();

        hold.release();
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

        expect([
            balance.contractLocked,
            balance.pendingSettlement,
            balance.reserved,
            balance.available,
        ]).toEqual([1, 10, 100, 1_000]);
    });
});

describe("durable reservations on a direct wallet", () => {
    const store = () =>
        new IndexedDBVtxoReservationRepository(`vtxo-reservations-${crypto.randomUUID()}`);

    it("persists an id-keyed hold when a reservation repository is configured", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const repository = store();
        const { wallet, coins, outpoints } = await fundedWallet({
            vtxoReservationRepository: repository,
        });
        const hold = await wallet.reserveVtxos([coins[0]], "taxi-transfer");
        expect(await repository.getReservations()).toEqual([
            { id: "taxi-transfer", outpoints: [{ txid: coins[0].txid, vout: 0 }] },
        ]);
        await expect(
            wallet.settle({ inputs: [coins[0]], outputs: [{ address: BTC_ADDR, amount: 9_000n }] }),
        ).rejects.toMatchObject({ name: "VtxoReservedError" });
        await wallet.dispose();

        const restarted = await fundedWallet({ vtxoReservationRepository: repository });
        expect((await restarted.wallet.getSpendableVtxos()).map(key)).not.toContain(outpoints[0]);
        await hold.release();
        expect(await repository.getReservations()).toEqual([]);
        await restarted.wallet.dispose();
    });

    it("keeps an id-keyed hold local without a reservation repository", async () => {
        const { wallet, coins, outpoints } = await fundedWallet();
        const hold = await wallet.reserveVtxos([coins[0]], "taxi-transfer");
        expect((await wallet.getSpendableVtxos()).map(key)).not.toContain(outpoints[0]);
        await hold.release();
        expect((await wallet.getSpendableVtxos()).map(key)).toContain(outpoints[0]);
        await wallet.dispose();
    });

    it("drops durable holds when the wallet is cleared", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const repository = store();
        const { wallet, coins, outpoints } = await fundedWallet({
            vtxoReservationRepository: repository,
        });
        await wallet.reserveVtxosPersistently([coins[0]], "taxi-transfer");
        expect(await repository.getReservations()).toHaveLength(1);
        await wallet.clear();
        expect(await repository.getReservations()).toEqual([]);

        const restored = await fundedWallet({ vtxoReservationRepository: repository });
        expect((await restored.wallet.getSpendableVtxos()).map(key)).toContain(outpoints[0]);
        await restored.wallet.dispose();
    });

    it("starts despite overlapping stored holds, holding each until its last owner releases", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const repository = store();
        const [a, b] = ["aa", "bb"].map((fill) => ({ txid: fill.repeat(32), vout: 0 }));
        await repository.saveReservation({ id: "first", outpoints: [a] });
        await repository.saveReservation({ id: "second", outpoints: [a, b] });

        const { wallet, coins, outpoints } = await fundedWallet({
            vtxoReservationRepository: repository,
        });
        const spendable = async () => (await wallet.getSpendableVtxos()).map(key);
        expect(await spendable()).not.toContain(outpoints[0]);
        expect(await spendable()).not.toContain(outpoints[1]);
        await expect(
            wallet.settle({ inputs: [coins[1]], outputs: [{ address: BTC_ADDR, amount: 9_000n }] }),
        ).rejects.toMatchObject({ name: "VtxoReservedError" });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("second"));

        await wallet.releaseVtxoReservation("second");
        expect((await repository.getReservations()).map(({ id }) => id)).toEqual(["first"]);
        expect(await spendable()).not.toContain(outpoints[0]);
        expect(await spendable()).toContain(outpoints[1]);

        await wallet.releaseVtxoReservation("first");
        expect(await spendable()).toContain(outpoints[0]);
        await wallet.dispose();
    });

    it("lets a released handle's repeat release leave a newer hold under its id alone", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const repository = store();
        const { wallet, coins, outpoints } = await fundedWallet({
            vtxoReservationRepository: repository,
        });
        const first = await wallet.reserveVtxos([coins[0]], "taxi-transfer");
        await first.release();
        await wallet.reserveVtxos([coins[1]], "taxi-transfer");

        await first.release();
        expect(await repository.getReservations()).toEqual([
            { id: "taxi-transfer", outpoints: [{ txid: coins[1].txid, vout: 0 }] },
        ]);
        expect((await wallet.getSpendableVtxos()).map(key)).not.toContain(outpoints[1]);
        await wallet.dispose();
    });

    it("lets a resumed id's stale handle leave a newer hold under its id alone", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const repository = store();
        const { wallet, coins, outpoints } = await fundedWallet({
            vtxoReservationRepository: repository,
        });
        const first = await wallet.reserveVtxos([coins[0]], "taxi-transfer");
        const resumed = await wallet.reserveVtxos([coins[0]], "taxi-transfer");
        await first.release();
        await wallet.reserveVtxos([coins[1]], "taxi-transfer");

        await resumed.release();
        expect(await repository.getReservations()).toEqual([
            { id: "taxi-transfer", outpoints: [{ txid: coins[1].txid, vout: 0 }] },
        ]);
        expect((await wallet.getSpendableVtxos()).map(key)).not.toContain(outpoints[1]);
        await wallet.dispose();
    });

    it("refuses a durable hold on an input a direct build is submitting", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, coins } = await fundedWallet({ vtxoReservationRepository: store() });
        const submits = stallSubmits(wallet);
        const building = wallet.buildAndSubmitOffchainTx([coins[0]], []);
        await vi.waitFor(() => expect(submits).toHaveLength(1));

        await expect(wallet.reserveVtxos([coins[0]], "taxi-transfer")).rejects.toMatchObject({
            holder: "in-flight",
        });
        submits[0].finish();
        await building;
        await (await wallet.reserveVtxos([coins[0]], "taxi-transfer")).release();
        await wallet.dispose();
    });
});
