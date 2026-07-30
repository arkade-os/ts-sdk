import { describe, it, expect, vi } from "vitest";
import { excludeLockedOutpoints, spendableVtxosExcludingLocked } from "../src/wallet/wallet";
import { InMemoryIntentRepository } from "../src/repositories/inMemory/intentRepository";
import type { ArkIntent } from "../src/repositories/intentRepository";

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
        const repo = new InMemoryIntentRepository();
        const base: Omit<ArkIntent, "state" | "intentVtxos"> = {
            intentTxId: "i",
            createdAt: 1,
            updatedAt: 1,
            registerProof: "",
            registerProofMessage: "",
            deleteProof: "",
            deleteProofMessage: "",
            partialForfeits: [],
        };
        await repo.saveIntent({
            ...base,
            state: "batch_in_progress",
            intentVtxos: [{ txid: "a", vout: 0 }],
        });
        expect((await spendableVtxosExcludingLocked(vtxos, repo)).map((v) => v.txid)).toEqual([
            "b",
        ]);
    });

    it("only reads the lock set — never mutates intent state", async () => {
        // The parameter type exposes getLockedVtxoOutpoints only; a passed
        // saveIntent must never be invoked from this read path.
        const saveIntent = vi.fn();
        const repo = {
            getLockedVtxoOutpoints: vi.fn().mockResolvedValue([]),
            saveIntent,
        };
        await spendableVtxosExcludingLocked(vtxos, repo);
        expect(saveIntent).not.toHaveBeenCalled();
    });
});
