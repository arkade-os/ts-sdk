import { afterEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress, InMemoryIntentRepository } from "../src";
import { Wallet } from "../src/wallet/wallet";
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

    it("ignores boarding inputs when checking for in-flight conflicts", () => {
        const txid = "aa".repeat(32);
        const thisArg = { _pendingSpendOutpoints: new Set([`${txid}:0`]) };
        const boarding = { txid, vout: 0, value: 1, status: { confirmed: true } };
        expect(() =>
            (Wallet.prototype as any)._assertNotInFlight.call(thisArg, [boarding]),
        ).not.toThrow();
    });
});
