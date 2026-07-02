import { describe, it, expect, vi } from "vitest";
import { excludeLockedOutpoints, spendableVtxosExcludingLocked } from "../src/wallet/wallet";

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
