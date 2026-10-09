import { afterEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress, InMemoryIntentRepository } from "../src";
import { Wallet } from "../src/wallet/wallet";
import { markSdkPicked } from "../src/wallet/utils";
import { BTC_ADDR, fundedWallet, parkSettle, stallSubmits } from "./concurrentSpendingFixture";

afterEach(() => vi.restoreAllMocks());

describe("send without concurrentSpending", () => {
    it("queues a second send behind the first, which then spends the first's change", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, outpoints } = await fundedWallet();
        const submits = stallSubmits(wallet);
        const to = await wallet.getAddress();
        const own = hex.encode(ArkAddress.decode(to).pkScript);

        const first = wallet.send({ address: to, amount: 2_000 });
        const second = wallet.send({ address: to, amount: 2_000 });
        await vi.waitFor(() => expect(submits).toHaveLength(1));
        await new Promise((r) => setTimeout(r, 50));
        expect(submits).toHaveLength(1);
        expect(submits[0].inputs).toEqual([outpoints[0]]);
        expect(submits[0].outputs).toEqual([
            [own, 2_000n],
            [own, 8_000n],
        ]);

        submits[0].finish();
        await expect(first).resolves.toBe("1".repeat(64));
        await vi.waitFor(() => expect(submits).toHaveLength(2));
        expect(submits[1].inputs).toEqual([`${"1".repeat(64)}:1`]);
        submits[1].finish();
        await expect(second).resolves.toBe("2".repeat(64));
        await wallet.dispose();
    });
});

describe("concurrentSpending", () => {
    it("picks disjoint inputs for two concurrent sends, in call order", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, outpoints } = await fundedWallet({ concurrentSpending: true });
        const submits = stallSubmits(wallet);
        const to = await wallet.getAddress();

        const first = wallet.send({ address: to, amount: 2_000 });
        const second = wallet.send({ address: to, amount: 2_000 });
        await vi.waitFor(() => expect(submits).toHaveLength(2));
        expect(submits.map((s) => s.inputs)).toEqual([[outpoints[0]], [outpoints[1]]]);

        submits.forEach((s) => s.finish());
        await expect(Promise.all([first, second])).resolves.toEqual([
            "1".repeat(64),
            "2".repeat(64),
        ]);
        await wallet.dispose();
    });

    it("lets a send through while a settle waits for its batch swap", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, arkProvider, coins, outpoints } = await fundedWallet({
            concurrentSpending: true,
        });
        const batch = parkSettle(wallet, arkProvider);
        const submits = stallSubmits(wallet);

        const settling = wallet.settle({
            inputs: [coins[0]],
            outputs: [{ address: BTC_ADDR, amount: 9_000n }],
        });
        await vi.waitFor(() => expect(arkProvider.registerIntent).toHaveBeenCalled());
        const sending = wallet.send({ address: await wallet.getAddress(), amount: 2_000 });
        await vi.waitFor(() => expect(submits).toHaveLength(1));
        expect(submits[0].inputs).toEqual([outpoints[1]]);

        submits[0].finish();
        await sending;
        batch.open();
        await settling.catch(() => undefined);
        await wallet.dispose();
    });

    it("without it, a send waits for the settle", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, arkProvider, coins } = await fundedWallet();
        const batch = parkSettle(wallet, arkProvider);
        const submits = stallSubmits(wallet);

        const settling = wallet.settle({
            inputs: [coins[0]],
            outputs: [{ address: BTC_ADDR, amount: 9_000n }],
        });
        await vi.waitFor(() => expect(arkProvider.registerIntent).toHaveBeenCalled());
        const sending = wallet.send({ address: await wallet.getAddress(), amount: 2_000 });
        await new Promise((r) => setTimeout(r, 50));
        expect(submits).toHaveLength(0);

        batch.open();
        await settling.catch(() => undefined);
        await vi.waitFor(() => expect(submits).toHaveLength(1));
        submits[0].finish();
        await sending;
        await wallet.dispose();
    });

    it("refuses to name a coin another send is spending", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, coins, outpoints } = await fundedWallet({ concurrentSpending: true });
        const submits = stallSubmits(wallet);
        const to = await wallet.getAddress();
        const first = wallet.send({ address: to, amount: 2_000 });
        await vi.waitFor(() => expect(submits).toHaveLength(1));

        await expect(
            wallet.send({
                recipients: [{ address: to, amount: 2_000 }],
                selectedVtxos: [coins[0]],
            }),
        ).rejects.toMatchObject({
            name: "VtxoReservedError",
            holder: "in-flight",
            outpoints: [outpoints[0]],
        });
        expect(submits).toHaveLength(1);

        submits[0].finish();
        await first;
        await wallet.dispose();
    });

    it("refuses a settle naming an in-flight coin before persisting an intent", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const intentRepository = new InMemoryIntentRepository();
        const { wallet, coins } = await fundedWallet({
            concurrentSpending: true,
            intentRepository,
        });
        const submits = stallSubmits(wallet);
        const first = wallet.send({ address: await wallet.getAddress(), amount: 2_000 });
        await vi.waitFor(() => expect(submits).toHaveLength(1));

        await expect(
            wallet.settle({ inputs: [coins[0]], outputs: [{ address: BTC_ADDR, amount: 9_000n }] }),
        ).rejects.toMatchObject({ name: "VtxoReservedError", holder: "in-flight" });
        expect(await intentRepository.getLockedVtxoOutpoints()).toEqual([]);

        submits[0].finish();
        await first;
        await wallet.dispose();
    });

    it("issues an asset from a free coin and releases the lock once it is reserved", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, outpoints } = await fundedWallet({ concurrentSpending: true });
        const submits = stallSubmits(wallet);
        const to = await wallet.getAddress();

        const sending = wallet.send({ address: to, amount: 2_000 });
        await vi.waitFor(() => expect(submits).toHaveLength(1));
        const issuing = wallet.assetManager.issue({ amount: 100n });
        await vi.waitFor(() => expect(submits).toHaveLength(2));
        const next = wallet.send({ address: to, amount: 2_000 });
        await vi.waitFor(() => expect(submits).toHaveLength(3));
        expect(submits.map((s) => s.inputs)).toEqual([
            [outpoints[0]],
            [outpoints[1]],
            [outpoints[2]],
        ]);

        submits.forEach((s) => s.finish());
        await Promise.all([sending, issuing, next]);
        await wallet.dispose();
    });

    it("refuses a second settle naming a boarding UTXO an in-flight settle is spending", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, arkProvider, coins } = await fundedWallet({ concurrentSpending: true });
        const batch = parkSettle(wallet, arkProvider);
        const boarding = boardingUtxo("dd");

        const settling = wallet.settle({
            inputs: [boarding, coins[0]],
            outputs: [{ address: BTC_ADDR, amount: 14_000n }],
        });
        await vi.waitFor(() => expect(arkProvider.registerIntent).toHaveBeenCalled());

        await expect(
            wallet.settle({ inputs: [boarding], outputs: [{ address: BTC_ADDR, amount: 4_000n }] }),
        ).rejects.toMatchObject({
            name: "VtxoReservedError",
            holder: "in-flight",
            outpoints: [`${boarding.txid}:0`],
        });
        expect(arkProvider.registerIntent).toHaveBeenCalledTimes(1);

        batch.open();
        await settling.catch(() => undefined);
        await wallet.dispose();
    });

    it("keeps a boarding UTXO an in-flight settle is spending out of getBoardingUtxos", async () => {
        const [spending, free] = [boardingUtxo("dd"), boardingUtxo("ee")];
        const thisArg = {
            boardingTapscript: { options: { serverPubKey: new Uint8Array(32).fill(2) } },
            getBoardingUtxosForSigners: async () => [{ coins: [spending, free] }],
            _pendingSpendOutpoints: new Set([`${spending.txid}:0`]),
        };
        expect(await (Wallet.prototype as any).getBoardingUtxos.call(thisArg)).toEqual([free]);
    });
});

describe("a hold placed while the SDK is picking", () => {
    it.each([true, false])(
        "concurrentSpending=%s: a send refuses a VTXO held after it was picked",
        async (concurrentSpending) => {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            const { wallet, arkProvider, coins } = await fundedWallet({ concurrentSpending });
            const submits = stallSubmits(wallet);
            const to = await wallet.getAddress();
            const gate = gateNextCalls(arkProvider.getInfo, await arkProvider.getInfo());
            const picked = vi.spyOn(wallet, "getSpendableVtxos");

            const sending = wallet.send({ address: to, amount: 2_000 });
            await vi.waitFor(() => expect(picked).toHaveBeenCalled());
            await vi.waitFor(() => expect(gate.waiting()).toBe(true));
            const hold = wallet.reserveVtxos([coins[0]]);
            gate.open();

            await expect(sending).rejects.toMatchObject({
                name: "VtxoReservedError",
                holder: "held",
            });
            expect(submits).toHaveLength(0);
            hold.release();
            await wallet.dispose();
        },
    );

    it("a bare settle refuses a VTXO held after it was picked, before registering", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, arkProvider, coins } = await fundedWallet({ concurrentSpending: true });
        parkSettle(wallet, arkProvider);
        let open!: () => void;
        const signing = new Promise<void>((resolve) => (open = resolve));
        const sign = vi
            .spyOn(wallet as any, "makeRegisterIntentSignature")
            .mockImplementation(async () => {
                await signing;
                return { proof: "", message: {} };
            });

        const settling = wallet.settle();
        await vi.waitFor(() => expect(sign).toHaveBeenCalled());
        const hold = wallet.reserveVtxos([coins[0]]);
        open();

        await expect(settling).rejects.toMatchObject({ name: "VtxoReservedError", holder: "held" });
        expect(arkProvider.registerIntent).not.toHaveBeenCalled();
        hold.release();
        await wallet.dispose();
    });

    it("a bare settle that loses a VTXO to a hold never blocks the holder spending it", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const intentRepository = new InMemoryIntentRepository();
        const { wallet, arkProvider, coins, outpoints } = await fundedWallet({
            concurrentSpending: true,
            intentRepository,
        });
        parkSettle(wallet, arkProvider);
        const submits = stallSubmits(wallet);
        let open!: () => void;
        const signing = new Promise<void>((resolve) => (open = resolve));
        const sign = vi
            .spyOn(wallet as any, "makeRegisterIntentSignature")
            .mockImplementation(async () => {
                await signing;
                return { proof: "", message: {} };
            });
        arkProvider.deleteIntent.mockImplementation(() => new Promise<undefined>(() => {}));

        const settled = wallet.settle().catch((error) => error);
        await vi.waitFor(() => expect(sign).toHaveBeenCalled());
        const hold = wallet.reserveVtxos([coins[0]]);
        const sent = wallet
            .send({
                recipients: [{ address: await wallet.getAddress(), amount: 2_000 }],
                selectedVtxos: [coins[0]],
            })
            .catch((error) => error);
        open();

        await vi.waitFor(() => expect(submits).toHaveLength(1));
        expect(submits[0].inputs).toEqual([outpoints[0]]);
        submits[0].finish();
        expect(await sent).toBe("1".repeat(64));
        expect(await settled).toMatchObject({ name: "VtxoReservedError", holder: "held" });
        expect(arkProvider.deleteIntent).not.toHaveBeenCalled();
        expect(await intentRepository.getLockedVtxoOutpoints()).toEqual([]);
        hold.release();
        await wallet.dispose();
    });

    it("a settle of SDK-picked inputs refuses one held since, while a named one spends it", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { wallet, arkProvider, coins } = await fundedWallet({ concurrentSpending: true });
        const batch = parkSettle(wallet, arkProvider);
        const hold = wallet.reserveVtxos([coins[0]]);
        const exitOf = () => ({
            inputs: [coins[0]],
            outputs: [{ address: BTC_ADDR, amount: 9_000n }],
        });

        await expect(wallet.settle(markSdkPicked(exitOf()))).rejects.toMatchObject({
            holder: "held",
        });
        expect(arkProvider.registerIntent).not.toHaveBeenCalled();
        const named = wallet.settle(exitOf());
        await vi.waitFor(() => expect(arkProvider.registerIntent).toHaveBeenCalledTimes(1));

        batch.open();
        await named.catch(() => undefined);
        hold.release();
        await wallet.dispose();
    });

    it.each([true, false])(
        "concurrentSpending=%s: an asset issue refuses a VTXO held after it was picked, and a hold refuses its inputs once claimed",
        async (concurrentSpending) => {
            vi.spyOn(console, "warn").mockImplementation(() => {});
            const { wallet, coins } = await fundedWallet({ concurrentSpending });
            const submits = stallSubmits(wallet);
            const address = await wallet.getAddress();
            const lookup = vi.spyOn(wallet, "getAddress");
            let open!: () => void;
            const resolving = new Promise<void>((resolve) => (open = resolve));
            lookup.mockImplementationOnce(async () => {
                await resolving;
                return address;
            });

            const issuing = wallet.assetManager.issue({ amount: 100n });
            await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
            const hold = wallet.reserveVtxos([coins[0]]);
            open();
            await expect(issuing).rejects.toMatchObject({ holder: "held" });
            hold.release();

            const retry = wallet.assetManager.issue({ amount: 100n });
            await vi.waitFor(() => expect(submits).toHaveLength(1));
            expect(() => wallet.reserveVtxos([coins[0]])).toThrow(/already being spent/);
            submits[0].finish();
            await retry;
            await wallet.dispose();
        },
    );
});

const boardingUtxo = (fill: string) =>
    ({ txid: fill.repeat(32), vout: 0, value: 5_000, status: { confirmed: true } }) as any;

/** Hold every call to `fn` until `open()`; `waiting()` reports whether one is held. */
function gateNextCalls<T>(fn: ReturnType<typeof vi.fn>, value: T) {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let held = false;
    fn.mockImplementation(async () => {
        held = true;
        await gate;
        return value;
    });
    return { open, waiting: () => held };
}
