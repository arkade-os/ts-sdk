import { describe, it, expect, vi } from "vitest";
import { excludeLockedOutpoints, spendableVtxosExcludingLocked } from "../src/wallet/wallet";
import { InMemoryBatchRegistrationRepository } from "../src/repositories/inMemory/intentRepository";
import type { BatchRegistration } from "../src/repositories/intentRepository";
import { fundedWallet } from "./concurrentSpendingFixture";

describe("excludeLockedOutpoints", () => {
    it("drops vtxos locked by non-terminal intents", () => {
        const vtxos = [
            { txid: "a", vout: 0, value: 100 },
            { txid: "b", vout: 1, value: 200 },
        ];
        const kept = excludeLockedOutpoints(vtxos, [{ txid: "a", vout: 0 }]);
        expect(kept.map((v) => v.txid)).toEqual(["b"]);
    });

    it("returns the input array unchanged when nothing is locked", () => {
        const vtxos = [{ txid: "a", vout: 0 }];
        expect(excludeLockedOutpoints(vtxos, [])).toBe(vtxos);
    });

    it("matches on both txid and vout", () => {
        const vtxos = [
            { txid: "a", vout: 0 },
            { txid: "a", vout: 1 },
        ];
        const kept = excludeLockedOutpoints(vtxos, [{ txid: "a", vout: 1 }]);
        expect(kept).toEqual([{ txid: "a", vout: 0 }]);
    });
});

describe("spendableVtxosExcludingLocked (getBalance offline-first, best-effort)", () => {
    const vtxos = [
        { txid: "a", vout: 0, value: 100 },
        { txid: "b", vout: 1, value: 200 },
    ];

    it("returns the input unchanged when no intent repository is configured", async () => {
        expect(await spendableVtxosExcludingLocked(vtxos, undefined)).toBe(vtxos);
    });

    it("excludes VTXOs locked by non-terminal intents", async () => {
        const repo = {
            getLockedVtxoOutpoints: vi.fn().mockResolvedValue([{ txid: "a", vout: 0 }]),
        };
        const kept = await spendableVtxosExcludingLocked(vtxos, repo);
        expect(kept.map((v) => v.txid)).toEqual(["b"]);
    });

    it("fails open to the unfiltered set when the intent store read rejects", async () => {
        const repo = {
            getLockedVtxoOutpoints: vi.fn().mockRejectedValue(new Error("db corrupt")),
        };
        expect(await spendableVtxosExcludingLocked(vtxos, repo)).toBe(vtxos);
    });

    it("hides a batch_in_progress intent's VTXO end-to-end (real repo lock logic)", async () => {
        // Pins the deliberate divergence from NArk EF storage: batch_in_progress
        // is non-terminal, so its inputs stay out of spendable balance.
        const repo = new InMemoryBatchRegistrationRepository();
        const base: Omit<BatchRegistration, "state" | "proofInputs"> = {
            proofTxId: "i",
            createdAt: 1,
            updatedAt: 1,
            registerProof: "",
            registerProofMessage: "",
            deleteProof: "",
            deleteProofMessage: "",
            partialForfeits: [],
        };
        await repo.saveBatchRegistration({
            ...base,
            state: "batch_in_progress",
            proofInputs: [{ txid: "a", vout: 0 }],
        });
        expect((await spendableVtxosExcludingLocked(vtxos, repo)).map((v) => v.txid)).toEqual([
            "b",
        ]);
    });
});

describe("intent-store failures before spending", () => {
    it.each(["selection", "send", "selected send", "settle", "selected settle"] as const)(
        "refuses %s when lock ownership cannot be read",
        async (operation) => {
            const repository = new InMemoryBatchRegistrationRepository();
            const { wallet, coins, arkProvider } = await fundedWallet({
                intentRepository: repository,
            });
            const failure = new Error("intent locks unavailable");
            vi.spyOn(repository, "getLockedVtxoOutpoints").mockRejectedValue(failure);
            const submit = vi
                .spyOn(wallet as any, "_buildAndSubmitOffchainTx")
                .mockResolvedValue({ arkTxid: "11".repeat(32), signedCheckpointTxs: [] });
            const recipient = { address: await wallet.getAddress(), amount: 2_000 };
            const operations = {
                selection: () => wallet.getSpendableVtxos(),
                send: () => wallet.send(recipient),
                "selected send": () =>
                    wallet.send({ recipients: [recipient], selectedVtxos: [coins[0]] }),
                settle: () => wallet.settle(),
                "selected settle": () => wallet.settle({ inputs: [coins[0]], outputs: [] }),
            };

            await expect(operations[operation]()).rejects.toBe(failure);
            expect(submit).not.toHaveBeenCalled();
            expect(arkProvider.registerIntent).not.toHaveBeenCalled();
        },
    );
});
