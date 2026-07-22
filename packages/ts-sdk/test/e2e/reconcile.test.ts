import { expect, describe, it, beforeEach } from "vitest";
import { createTestArkWallet, createVtxo, beforeEachFaucet } from "./utils";
import { RestIndexerProvider } from "../../src";
import { RECONCILE_ABSENCE_THRESHOLD } from "../../src/contracts/contractManager";

describe("Reconcile vanished VTXOs (chain reset)", () => {
    beforeEach(beforeEachFaucet, 20000);

    // The whole reconcile relies on the indexer returning nothing (not an error)
    // for an outpoint it does not know. This pins that assumption to the real server.
    it("indexer returns empty for an outpoint it does not know", { timeout: 60000 }, async () => {
        const indexer = new RestIndexerProvider("http://localhost:7070");

        const res = await indexer.getVtxos({
            outpoints: [{ txid: "ff".repeat(32), vout: 0 }],
        });

        expect(res.vtxos).toEqual([]);
    });

    it(
        "drops a stored VTXO the indexer no longer reports, keeps the real one",
        { timeout: 60000 },
        async () => {
            const alice = await createTestArkWallet();
            await createVtxo(alice, 10000);

            const address = await alice.wallet.getAddress();
            const real = await alice.wallet.getVtxos();
            expect(real.length).toBeGreaterThan(0);
            const realTxid = real[0].txid;

            // Inject a ghost: a real coin's shape with an outpoint the indexer never knew.
            const ghostTxid = "ff".repeat(32);
            const ghost = { ...real[0], txid: ghostTxid };
            await alice.wallet.walletRepository.saveVtxos(address!, [ghost]);
            const stored = await alice.wallet.walletRepository.getVtxos(address!);
            expect(stored.some((v) => v.txid === ghostTxid)).toBe(true);

            // Reconcile deletes it after the absence threshold; reset the cooldown
            // each pass so the rapid loop actually re-checks.
            const manager = await alice.wallet.getContractManager();
            const throttle = manager as unknown as { lastReconcileByContract: Map<string, number> };
            for (let i = 0; i < RECONCILE_ABSENCE_THRESHOLD; i++) {
                throttle.lastReconcileByContract.clear();
                await alice.wallet.getVtxos();
            }

            const after = await alice.wallet.getVtxos();
            expect(after.some((v) => v.txid === ghostTxid)).toBe(false);
            expect(after.some((v) => v.txid === realTxid)).toBe(true);
        },
    );
});
