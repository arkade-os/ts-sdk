import { beforeEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    DefaultContractHandler,
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestIndexerProvider,
    SingleKey,
    Wallet,
    networks,
} from "../../src";
import { ARK_URL, ESPLORA_API_URL, beforeEachFaucet, faucetOffchain } from "./utils";

describe("contract subscription recovery", () => {
    beforeEach(beforeEachFaucet, 120_000);

    it.each(["reject", "stall"])(
        "discovers a deposit when subscription POSTs %s without reconnecting",
        async (failure) => {
            const indexer = new RestIndexerProvider(ARK_URL);
            const stream = vi.spyOn(indexer, "getSubscription");
            const repository = new InMemoryWalletRepository();
            const wallet = await Wallet.create({
                identity: SingleKey.fromRandomBytes(),
                arkProvider: new RestArkProvider(ARK_URL),
                indexerProvider: indexer,
                onchainProvider: new EsploraProvider(ESPLORA_API_URL),
                storage: {
                    contractRepository: new InMemoryContractRepository(),
                    walletRepository: repository,
                },
                watcherConfig: {
                    reconnectDelayMs: 100,
                    maxReconnectDelayMs: 200,
                    subscriptionRequestTimeoutMs: 1_000,
                },
                settlementConfig: false,
            });

            try {
                const manager = await wallet.getContractManager();
                const [own] = await manager.getContracts({ type: "default" });
                const other = SingleKey.fromRandomBytes();
                const params: Record<string, string> = {
                    ...own.params,
                    pubKey: hex.encode(await other.xOnlyPublicKey()),
                };
                const tapscript = DefaultContractHandler.createScript(params);
                const script = hex.encode(tapscript.pkScript);
                const address = tapscript
                    .address(networks.regtest.hrp, hex.decode(params.serverPubKey))
                    .encode();
                await manager.createContract({
                    type: "default",
                    params,
                    script,
                    address,
                    watch: "retained",
                });

                // Interrupt only subscription POSTs. The real event stream stays connected.
                const fetch = globalThis.fetch.bind(globalThis);
                let unavailable = true;
                let failures = 0;
                vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
                    if (
                        unavailable &&
                        String(input).endsWith("/v1/indexer/script/subscribe") &&
                        init?.method === "POST"
                    ) {
                        failures++;
                        if (failure === "stall") {
                            return new Promise<Response>((_resolve, reject) => {
                                const signal = init.signal!;
                                if (signal.aborted) reject(signal.reason);
                                else
                                    signal.addEventListener("abort", () => reject(signal.reason), {
                                        once: true,
                                    });
                            });
                        }
                        return Promise.resolve(
                            new Response("temporarily unavailable", { status: 503 }),
                        );
                    }
                    return fetch(input, init);
                });
                const streamsBeforeFailure = stream.mock.calls.length;
                let promoted = false;
                const promotion = manager.setContractWatchState(script, "watched").then(() => {
                    promoted = true;
                });
                await vi.waitFor(() => expect(promoted).toBe(true), { timeout: 3_000 });
                await promotion;
                expect(failures).toBe(1);
                await manager.setContractWatchState(script, "watched");
                expect(failures).toBe(1);

                faucetOffchain(address, 2_000);
                await vi.waitFor(
                    async () => {
                        const { vtxos } = await indexer.getVtxos({ scripts: [script] });
                        expect(vtxos.some((vtxo) => vtxo.value === 2_000)).toBe(true);
                    },
                    { timeout: 10_000 },
                );
                expect((await repository.getVtxosPage(address, { limit: 10 })).items).toHaveLength(
                    0,
                );

                // Only restore transport availability, without a setter, refresh or reconnect.
                unavailable = false;
                await vi.waitFor(
                    async () => {
                        const { items } = await repository.getVtxosPage(address, { limit: 10 });
                        expect(items.map((vtxo) => vtxo.value)).toContain(2_000);
                    },
                    { timeout: 5_000 },
                );
                expect(stream).toHaveBeenCalledTimes(streamsBeforeFailure);
                expect((await wallet.getBalance()).total).toBe(2_000);
            } finally {
                await wallet.dispose();
                vi.restoreAllMocks();
            }
        },
        30_000,
    );
});
