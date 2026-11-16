import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceWorkerWallet } from "../../src/wallet/serviceWorker/wallet";
import { WalletMessageHandler } from "../../src/wallet/serviceWorker/wallet-message-handler";
import { fundedWallet, stallSubmits } from "../concurrentSpendingFixture";
import { IndexedDBVtxoReservationRepository } from "../../src/repositories/indexedDB/vtxoReservationRepository";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { SingleKey } from "../../src/identity";
import { bindTestWallet, scopedWalletRequest } from "../helpers/walletRequest";

afterEach(() => vi.restoreAllMocks());

const key = (coin: { txid: string; vout: number }) => `${coin.txid}:${coin.vout}`;

async function setup(
    dbName = `vtxo-reservations-${crypto.randomUUID()}`,
    operatorUrl = "https://ark.example/ark/",
    identity?: SingleKey,
) {
    const repository = new IndexedDBVtxoReservationRepository(dbName);
    const fixture = await fundedWallet({
        concurrentSpending: true,
        vtxoReservationRepository: repository,
    });
    const handler = new WalletMessageHandler() as any;
    const proxyIdentity = identity ?? fixture.wallet.identity;
    const url = new URL(operatorUrl);
    const scope = hex.encode(
        sha256(
            new TextEncoder().encode(
                `${url.origin}${url.pathname.replace(/\/$/, "")}|${hex.encode(await proxyIdentity.xOnlyPublicKey())}`,
            ),
        ),
    );
    const binding = { scope, network: fixture.wallet.network.name! };
    await handler.start(
        {
            wallet: fixture.wallet,
            readonlyWallet: fixture.wallet,
            arkProvider: fixture.arkProvider,
            walletRequestBinding: binding,
        },
        { walletRepository: fixture.wallet.walletRepository },
    );
    const sendMessage = vi.fn(async (message) => {
        const response = await handler.handleMessage(structuredClone(message));
        if (response.error) throw response.error;
        return response;
    });
    const proxy = bindTestWallet(
        Object.assign(Object.create(ServiceWorkerWallet.prototype), {
            messageTag: "test",
            sendMessageDirect: sendMessage,
            pingServiceWorker: async () => {},
            inflightRequests: new Map(),
            messageTimeouts: {},
            identity: proxyIdentity,
            initConfig: { arkServer: { url: operatorUrl } },
        }) as ServiceWorkerWallet,
        binding,
    );
    return { ...fixture, handler, proxy, sendMessage, repository, dbName, scope };
}

describe("service-worker VTXO reservations", () => {
    it("excludes externally held inputs from a normal worker send until released", async () => {
        const { wallet, coins, outpoints, proxy } = await setup();
        const reservation = await proxy.reserveVtxos([coins[0]], "taxi-transfer");
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
        await expect(proxy.reserveVtxos(coins, "taxi-transfer")).rejects.toMatchObject({
            name: "VtxoReservedError",
        });
        expect((await wallet.getSpendableVtxos()).map(key)).toContain(outpoints[1]);
        submits[0].finish();
        await sending;
    });

    it("retries a failed release and ignores unrelated or repeated releases", async () => {
        const { wallet, coins, outpoints, proxy, sendMessage, handler } = await setup();
        const reservation = await proxy.reserveVtxos([coins[0]], "taxi-transfer");
        await handler.handleMessage(
            scopedWalletRequest(
                {
                    tag: "test",
                    type: "RELEASE_SCOPED_VTXOS",
                    id: "foreign-release",
                    payload: {
                        reservationId: "someone-else",
                        scope: handler.walletRequestBinding.scope,
                    },
                },
                handler.walletRequestBinding,
            ),
        );
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

    it.each([undefined, "", null])(
        "requires a recoverable operation id before acquiring: %s",
        async (id) => {
            const { proxy, coins, sendMessage, repository } = await setup();
            await expect(proxy.reserveVtxos([coins[0]], id as string)).rejects.toThrow(
                "Reservation id is required",
            );
            expect(sendMessage).not.toHaveBeenCalled();
            expect(await repository.getReservations()).toEqual([]);
        },
    );

    it("recovers a lost acquisition reply by the persisted application id after restart", async () => {
        const dbName = `vtxo-reservations-${crypto.randomUUID()}`;
        const original = await setup(dbName);
        const deliver = original.sendMessage.getMockImplementation()!;
        original.sendMessage.mockImplementationOnce(async (message) => {
            await deliver(message);
            throw new Error("reply lost");
        });
        await expect(
            original.proxy.reserveVtxos([original.coins[0]], "taxi-transfer"),
        ).rejects.toThrow("reply lost");
        expect(await original.repository.getReservations()).toHaveLength(1);
        await original.wallet.dispose();
        await original.repository[Symbol.asyncDispose]();
        const restarted = await setup(dbName, "https://ark.example/ark?ignored=1#fragment");
        const resumed = await restarted.proxy.reserveVtxos([restarted.coins[0]], "taxi-transfer");
        await resumed.release();
        expect(await restarted.repository.getReservations()).toEqual([]);
    });

    it("fails closed when an older active worker only understands unscoped reservations", async () => {
        const { proxy, coins, sendMessage, repository } = await setup();
        const retained = await proxy.reserveVtxos([coins[0]], "taxi-transfer");
        const deliver = sendMessage.getMockImplementation()!;
        sendMessage.mockImplementation(async (message) => {
            if (message.type === "RESERVE_VTXOS" || message.type === "RELEASE_VTXOS") {
                return deliver(message);
            }
            throw new Error("Unknown request type");
        });
        await expect(proxy.reserveVtxos([coins[1]], "other-transfer")).rejects.toThrow(
            "Unknown request type",
        );
        await expect(retained.release()).rejects.toThrow("Unknown request type");
        expect(await repository.getReservations()).toEqual([
            { id: "taxi-transfer", outpoints: [{ txid: coins[0].txid, vout: 0 }] },
        ]);
    });

    it.each(["operator origin", "operator path", "identity"])(
        "fences retained handles and stale acquisition after changing %s",
        async (changed) => {
            const original = await setup();
            const retained = await original.proxy.reserveVtxos(
                [original.coins[0]],
                "taxi-transfer",
            );
            await original.handler.stop();
            const replacement = await setup(
                undefined,
                changed === "operator origin"
                    ? "https://other.example/ark"
                    : changed === "operator path"
                      ? "https://ark.example/other"
                      : "https://ark.example/ark",
                changed === "identity" ? SingleKey.fromHex("12".repeat(32)) : undefined,
            );
            await replacement.proxy.reserveVtxos([replacement.coins[1]], "taxi-transfer");
            await original.handler.start(
                {
                    wallet: replacement.wallet,
                    readonlyWallet: replacement.wallet,
                    arkProvider: replacement.arkProvider,
                    walletRequestBinding: {
                        scope: replacement.scope,
                        network: replacement.wallet.network.name,
                    },
                },
                { walletRepository: replacement.wallet.walletRepository },
            );
            await expect(retained.release()).rejects.toThrow("Wallet request scope does not match");
            await expect(
                original.proxy.reserveVtxos([original.coins[2]], "other-transfer"),
            ).rejects.toThrow("Wallet request scope does not match");
            expect(await replacement.repository.getReservations()).toEqual([
                { id: "taxi-transfer", outpoints: [{ txid: replacement.coins[1].txid, vout: 0 }] },
            ]);
            const resumed = await setup(original.dbName);
            await original.handler.start(
                {
                    wallet: resumed.wallet,
                    readonlyWallet: resumed.wallet,
                    arkProvider: resumed.arkProvider,
                    walletRequestBinding: {
                        scope: resumed.scope,
                        network: resumed.wallet.network.name,
                    },
                },
                { walletRepository: resumed.wallet.walletRepository },
            );
            await retained.release();
            expect(await resumed.repository.getReservations()).toEqual([]);
        },
    );

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
