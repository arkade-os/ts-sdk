import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryVirtualTxRepository } from "../../src/repositories/inMemory/virtualTxRepository";
import { createExitChainResolver } from "../../src/wallet/exit/resolver";
import {
    beforeEachFaucet,
    createTestArkWallet,
    createVtxo,
    mineBlocks,
    refreshWallet,
    waitFor,
} from "./utils";

describe("exit-data capture (e2e)", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "captures a branch on receive, exits from the repo offline, and prunes on spend",
        { timeout: 180_000 },
        async () => {
            const repo = new InMemoryVirtualTxRepository();
            const alice = await createTestArkWallet({
                virtualTxRepository: repo,
                exitDataCapture: { mode: "full" },
            });
            const address = await alice.wallet.getAddress();

            // A settled VTXO, then an off-chain self-send so the surviving VTXO has
            // a real off-chain chain (ARK + checkpoint) worth capturing PSBTs for.
            await createVtxo(alice, 200_000);
            await alice.wallet.send({ address, amount: 150_000 });
            // Both self-send outputs must be visible before picking the spine:
            // reads are repository-only, and `send` writes its outputs locally
            // one at a time, so a bare `length >= 1` can select the change and
            // leave the test asserting against a VTXO it never spends.
            await waitFor(
                async () => {
                    await refreshWallet(alice.wallet);
                    return (await alice.wallet.getVtxos()).length >= 2;
                },
                { timeout: 30_000 },
            );
            mineBlocks(1);
            const spine = (await alice.wallet.getVtxos()).reduce((a, b) =>
                a.value > b.value ? a : b,
            );
            const vtxo = { txid: spine.txid, vout: spine.vout };

            // Capture wiring: ContractManager persisted the branch on receive.
            await waitFor(
                async () => {
                    await refreshWallet(alice.wallet);
                    return await repo.hasBranch(vtxo);
                },
                { timeout: 30_000 },
            );
            expect((await repo.getBranch(vtxo)).length).toBeGreaterThan(0);

            // Offline exit read: a repo-only resolver (indexer throws) still resolves
            // the chain — Full-mode PSBTs let it reconstruct structure locally.
            const dead = {
                getVtxoChain: async () => {
                    throw new Error("indexer offline");
                },
                getVirtualTxs: async () => {
                    throw new Error("indexer offline");
                },
            } as never;
            const repoOnly = createExitChainResolver({ indexer: dead, repository: repo });
            expect((await repoOnly.getVtxoChain(vtxo)).length).toBeGreaterThan(0);

            // Prune wiring: spending the VTXO drops its branch. `onVtxosSpent`
            // fires only from the watcher's `vtxo_spent` event, so a refresh
            // can't force it — the budget has to cover the failsafe poll
            // interval now that no read syncs on the way past.
            await alice.wallet.send({ address, amount: 20_000 });
            await waitFor(async () => !(await repo.hasBranch(vtxo)), { timeout: 60_000 });
        },
    );
});
