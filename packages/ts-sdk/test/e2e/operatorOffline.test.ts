import { beforeEach, describe, expect, it } from "vitest";
import { Wallet, EsploraProvider } from "../../src";
import {
    beforeEachFaucet,
    createSharedRepos,
    createTestIdentity,
    createVtxo,
    waitFor,
} from "./utils";

// End-to-end coverage for the offline-first wallet: a previously-synced wallet
// must open and serve cached reads when the operator is unreachable, and report
// its degraded provider-connection state.
describe("operator offline (e2e)", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "creates offline from the cached snapshot and serves cached reads",
        { timeout: 120_000 },
        async () => {
            const repos = createSharedRepos();
            const identity = createTestIdentity();
            const onchain = () =>
                new EsploraProvider("http://localhost:3000/api", {
                    forcePolling: true,
                    pollingInterval: 2000,
                });

            // 1) Create online against the live operator: persists the ArkInfo
            //    snapshot and (after funding) the VTXO set into the shared repos.
            const online = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: onchain(),
                storage: {
                    walletRepository: repos.walletRepository,
                    contractRepository: repos.contractRepository,
                },
                settlementConfig: false,
            });
            expect(online.getProviderConnectionState().mode).toBe("online");

            await createVtxo({ wallet: online, identity }, 100_000);
            await waitFor(async () => (await online.getVtxos()).length >= 1, { timeout: 30_000 });
            const cachedVtxos = await online.getVtxos();
            expect(cachedVtxos.length).toBeGreaterThan(0);

            // 2) Re-create the SAME wallet (same identity + repos) pointed at an
            //    unreachable operator. Port 9 is deterministically unreachable
            //    (undici rejects it), so every request rejects as a retryable
            //    provider error. Create must SUCCEED from the cached snapshot.
            const offline = await Wallet.create({
                identity,
                arkServerUrl: "http://127.0.0.1:9",
                onchainProvider: onchain(),
                storage: {
                    walletRepository: repos.walletRepository,
                    contractRepository: repos.contractRepository,
                },
                settlementConfig: false,
            });

            // 3) Reads serve cached state; the connection state reports degraded.
            const offlineVtxos = await offline.getVtxos();
            expect(offlineVtxos.map((v) => `${v.txid}:${v.vout}`).sort()).toEqual(
                cachedVtxos.map((v) => `${v.txid}:${v.vout}`).sort(),
            );
            expect(offline.getProviderConnectionState().mode).toBe("degraded");
            expect(offline.serverInfoSource).toBe("cache");
        },
    );
});
