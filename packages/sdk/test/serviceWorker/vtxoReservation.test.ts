import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceWorkerWallet } from "../../src/wallet/serviceWorker/wallet";
import { WalletMessageHandler } from "../../src/wallet/serviceWorker/wallet-message-handler";
import { fundedWallet, stallSubmits } from "../concurrentSpendingFixture";
import { IndexedDBVtxoReservationRepository } from "../../src/repositories/indexedDB/vtxoReservationRepository";

afterEach(() => vi.restoreAllMocks());

const key = (coin: { txid: string; vout: number }) => `${coin.txid}:${coin.vout}`;

async function setup(dbName = `vtxo-reservations-${crypto.randomUUID()}`) {
    const repository = new IndexedDBVtxoReservationRepository(dbName);
    const fixture = await fundedWallet({
        concurrentSpending: true,
        vtxoReservationRepository: repository,
    });
    const handler = new WalletMessageHandler() as any;
    handler.wallet = fixture.wallet;
    handler.readonlyWallet = fixture.wallet;
    handler.walletRepository = fixture.wallet.walletRepository;
    const sendMessage = vi.fn(async (message) => {
        const response = await handler.handleMessage(structuredClone(message));
        if (response.error) throw response.error;
        return response;
    });
    const proxy = Object.assign(Object.create(ServiceWorkerWallet.prototype), {
        messageTag: "test",
        sendMessage,
    }) as ServiceWorkerWallet;
    return { ...fixture, handler, proxy, sendMessage, repository };
}

describe("service-worker VTXO reservations", () => {
    it("excludes externally held inputs from a normal worker send until released", async () => {
        const { wallet, coins, outpoints, proxy } = await setup();
        const reservation = await proxy.reserveVtxos([coins[0]]);
        expect(await proxy.getBalance()).toMatchObject({ available: 20_000, reserved: 10_000 });
        expect((await wallet.getSpendableVtxos()).map(key)).not.toContain(outpoints[0]);
        const submits = stallSubmits(wallet);
        await expect(
            proxy.send({
                recipients: [{ address: await wallet.getAddress(), amount: 2_000 }],
                selectedVtxos: [coins[0]],
            }),
        ).rejects.toMatchObject({ name: "VtxoReservedError" });
        await expect(wallet.settle({ inputs: [coins[0]], outputs: [] })).rejects.toMatchObject({
            name: "VtxoReservedError",
        });
        expect(submits).toHaveLength(0);
        const sending = proxy.send({ address: await wallet.getAddress(), amount: 2_000 });
        await vi.waitFor(() => expect(submits).toHaveLength(1));
        expect(submits[0].inputs).toEqual([outpoints[1]]);
        submits[0].finish();
        await sending;

        await reservation.release();
        expect((await wallet.getSpendableVtxos()).map(key)).toContain(outpoints[0]);
    });

    it("rejects an in-flight input without reserving the rest of the selection", async () => {
        const { wallet, coins, outpoints, proxy } = await setup();
        const submits = stallSubmits(wallet);
        const sending = proxy.send({ address: await wallet.getAddress(), amount: 2_000 });
        await vi.waitFor(() => expect(submits).toHaveLength(1));
        await expect(proxy.reserveVtxos(coins)).rejects.toMatchObject({
            name: "VtxoReservedError",
        });
        expect((await wallet.getSpendableVtxos()).map(key)).toContain(outpoints[1]);
        submits[0].finish();
        await sending;
    });

    it("retries a failed release and ignores unrelated or repeated releases", async () => {
        const { wallet, coins, outpoints, proxy, sendMessage, handler } = await setup();
        const reservation = await proxy.reserveVtxos([coins[0]]);
        await handler.handleMessage({
            tag: "test",
            type: "RELEASE_VTXOS",
            id: "foreign-release",
            payload: { reservationId: "someone-else" },
        });
        expect((await wallet.getSpendableVtxos()).map(key)).not.toContain(outpoints[0]);
        sendMessage.mockRejectedValueOnce(new Error("worker unavailable"));
        await expect(reservation.release()).rejects.toThrow("worker unavailable");
        expect((await wallet.getSpendableVtxos()).map(key)).not.toContain(outpoints[0]);
        await reservation.release();
        const requests = sendMessage.mock.calls.length;
        await reservation.release();
        expect(sendMessage).toHaveBeenCalledTimes(requests);
        expect((await wallet.getSpendableVtxos()).map(key)).toContain(outpoints[0]);
    });

    it("restores a closed tab's holds before a different proxy can send after worker restart", async () => {
        const dbName = `vtxo-reservations-${crypto.randomUUID()}`;
        const original = await setup(dbName);
        await original.proxy.reserveVtxos([original.coins[0]], "taxi-transfer");
        await original.wallet.dispose();
        await original.repository[Symbol.asyncDispose]();

        const restarted = await setup(dbName);
        expect((await restarted.wallet.getSpendableVtxos()).map(key)).not.toContain(
            original.outpoints[0],
        );
        const submits = stallSubmits(restarted.wallet);
        const sending = restarted.proxy.send({
            address: await restarted.wallet.getAddress(),
            amount: 2_000,
        });
        await vi.waitFor(() => expect(submits).toHaveLength(1));
        expect(submits[0].inputs).toEqual([restarted.outpoints[1]]);
        submits[0].finish();
        await sending;
        const resumed = await restarted.proxy.reserveVtxos([restarted.coins[0]], "taxi-transfer");
        await resumed.release();
        expect(await restarted.repository.getReservations()).toEqual([]);
        expect((await restarted.wallet.getSpendableVtxos()).map(key)).toContain(
            restarted.outpoints[0],
        );
    });

    it("does not acknowledge a hold or release when its storage commit fails", async () => {
        const { wallet, coins, outpoints, proxy, repository } = await setup();
        const save = vi
            .spyOn(repository, "saveReservation")
            .mockRejectedValueOnce(new Error("disk full"));
        await expect(proxy.reserveVtxos([coins[0]], "taxi-transfer")).rejects.toThrow("disk full");
        expect((await wallet.getSpendableVtxos()).map(key)).toContain(outpoints[0]);
        save.mockRestore();
        const hold = await proxy.reserveVtxos([coins[0]], "taxi-transfer");
        vi.spyOn(repository, "deleteReservation").mockRejectedValueOnce(new Error("delete failed"));
        await expect(hold.release()).rejects.toThrow("delete failed");
        expect((await wallet.getSpendableVtxos()).map(key)).not.toContain(outpoints[0]);
        expect(await repository.getReservations()).toHaveLength(1);
        await hold.release();
        expect(await repository.getReservations()).toEqual([]);
    });

    it("drains a pending reservation write before a replacement wallet restores it", async () => {
        const dbName = `vtxo-reservations-${crypto.randomUUID()}`;
        const original = await setup(dbName);
        let commit!: () => void;
        const gate = new Promise<void>((resolve) => {
            commit = resolve;
        });
        const save = original.repository.saveReservation.bind(original.repository);
        const saving = vi
            .spyOn(original.repository, "saveReservation")
            .mockImplementation(async (reservation) => {
                await gate;
                await save(reservation);
            });
        const acquire = original.proxy.reserveVtxos([original.coins[0]], "taxi-transfer");
        await vi.waitFor(() => expect(saving).toHaveBeenCalledOnce());
        let disposed = false;
        const disposal = original.wallet.dispose().then(() => {
            disposed = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(disposed).toBe(false);
        commit();
        await acquire;
        await disposal;
        await original.repository[Symbol.asyncDispose]();

        const successor = await setup(dbName);
        expect((await successor.wallet.getSpendableVtxos()).map(key)).not.toContain(
            original.outpoints[0],
        );
    });
});
