import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    DefaultContractHandler,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestIndexerProvider,
    SingleKey,
    Wallet,
    networks,
} from "../../src";

describe("contract watch state idempotency", () => {
    it.each([false, true])(
        "resumes watching with a failed subscription update: %s",
        async (failUpdate) => {
            const indexer = new RestIndexerProvider("http://localhost:7070");
            // This spy calls the real provider: each invocation sends a subscription POST.
            const subscribe = vi.spyOn(indexer, "subscribeForScripts");
            const fetchVtxos = vi.spyOn(indexer, "getVtxos");
            const wallet = await Wallet.create({
                identity: SingleKey.fromRandomBytes(),
                arkProvider: new RestArkProvider("http://localhost:7070"),
                indexerProvider: indexer,
                storage: {
                    contractRepository: new InMemoryContractRepository(),
                    walletRepository: new InMemoryWalletRepository(),
                },
                settlementConfig: false,
            });

            try {
                const manager = await wallet.getContractManager();
                const [own] = await manager.getContracts({ type: "default" });
                const other = SingleKey.fromRandomBytes();
                const params = { ...own.params, pubKey: hex.encode(await other.xOnlyPublicKey()) };
                const tapscript = DefaultContractHandler.createScript(params);
                const script = hex.encode(tapscript.pkScript);
                const address = tapscript
                    .address(networks.regtest.hrp, hex.decode(params.serverPubKey))
                    .encode();
                await manager.createContract({ type: "default", params, script, address });
                subscribe.mockClear();

                await manager.setContractWatchState(script, "retained");
                expect(subscribe).toHaveBeenCalledTimes(1);
                expect(subscribe.mock.calls[0][0]).toContain(own.script);
                expect(subscribe.mock.calls[0][0]).not.toContain(script);
                await expect(subscribe.mock.results[0].value).resolves.toEqual(expect.any(String));
                subscribe.mockClear();

                await manager.setContractWatchState(script, "retained");
                await manager.setContractWatchState(script, "retained");
                expect(subscribe).not.toHaveBeenCalled();
                expect((await manager.getContracts({ script }))[0]).toMatchObject({
                    watch: "retained",
                    address,
                    params,
                });

                if (failUpdate) {
                    fetchVtxos.mockClear();
                    // Fail only the update request; leave the real event stream connected.
                    subscribe.mockRejectedValueOnce(
                        new Error("temporary subscription POST failure"),
                    );
                }
                await manager.setContractWatchState(script, "watched");
                expect(subscribe).toHaveBeenCalledTimes(1);
                if (failUpdate) {
                    await expect(subscribe.mock.results[0].value).rejects.toThrow(
                        "temporary subscription POST failure",
                    );
                    // Repeating the setter remains a no-op. The watcher owns recovery.
                    await manager.setContractWatchState(script, "watched");
                    expect(subscribe).toHaveBeenCalledTimes(1);
                    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2), {
                        timeout: 5000,
                    });
                }
                expect(subscribe.mock.calls[0][0]).toEqual(
                    expect.arrayContaining([own.script, script]),
                );
                const recovered = subscribe.mock.calls.length - 1;
                expect(subscribe.mock.calls[recovered][0]).toEqual(
                    expect.arrayContaining([own.script, script]),
                );
                await expect(subscribe.mock.results[recovered].value).resolves.toEqual(
                    expect.any(String),
                );
                if (failUpdate) {
                    // Recovery must fetch missed activity, not just repair future events.
                    await vi.waitFor(() =>
                        expect(fetchVtxos).toHaveBeenCalledWith(
                            expect.objectContaining({ scripts: expect.arrayContaining([script]) }),
                        ),
                    );
                    for (const result of fetchVtxos.mock.results) {
                        await expect(result.value).resolves.toHaveProperty("vtxos");
                    }
                }
                expect((await manager.getContracts({ script }))[0].watch).toBe("watched");
            } finally {
                await wallet.dispose();
                subscribe.mockRestore();
                fetchVtxos.mockRestore();
            }
        },
        30000,
    );
});
