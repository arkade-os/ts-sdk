import { describe, it, expect, vi } from "vitest";
import {
    shouldPruneSpentVtxo,
    ContractManager,
} from "../src/contracts/contractManager";
import type { VirtualCoin } from "../src/wallet";

const vtxo = (over: Partial<VirtualCoin>): VirtualCoin =>
    ({ txid: "t", vout: 0, isUnrolled: false, ...over }) as VirtualCoin;

describe("shouldPruneSpentVtxo", () => {
    it("prunes an offchain-spent, non-unrolled output", () => {
        expect(shouldPruneSpentVtxo(vtxo({ isSpent: true }))).toBe(true);
    });

    it("prunes an onchain-settled (settledBy) non-unrolled output", () => {
        expect(shouldPruneSpentVtxo(vtxo({ settledBy: "ctx" }))).toBe(true);
    });

    it("never prunes an unrolled output, even if spent or settled", () => {
        expect(
            shouldPruneSpentVtxo(vtxo({ isSpent: true, isUnrolled: true }))
        ).toBe(false);
        expect(
            shouldPruneSpentVtxo(vtxo({ settledBy: "ctx", isUnrolled: true }))
        ).toBe(false);
    });

    it("does not prune unspent / swept-without-isSpent-or-settledBy", () => {
        expect(shouldPruneSpentVtxo(vtxo({ isSpent: false }))).toBe(false);
        expect(shouldPruneSpentVtxo(vtxo({}))).toBe(false);
    });
});

describe("ContractManager.pruneSpentVirtualTxs (automated GC glue)", () => {
    const call = (config: unknown, vtxos: VirtualCoin[]) =>
        (
            ContractManager.prototype as unknown as {
                pruneSpentVirtualTxs: (v: VirtualCoin[]) => Promise<void>;
            }
        ).pruneSpentVirtualTxs.call({ config }, vtxos);

    it("prunes only eligible outpoints, with the right outpoint", async () => {
        const pruneForSpentVtxo = vi.fn().mockResolvedValue(undefined);
        await call({ virtualTxRepository: { pruneForSpentVtxo } }, [
            vtxo({ txid: "spent", vout: 1, isSpent: true }),
            vtxo({ txid: "settled", vout: 2, settledBy: "ctx" }),
            vtxo({ txid: "live", vout: 0, isSpent: false }),
            vtxo({ txid: "exiting", vout: 0, isSpent: true, isUnrolled: true }),
        ]);
        expect(pruneForSpentVtxo).toHaveBeenCalledTimes(2);
        expect(pruneForSpentVtxo).toHaveBeenCalledWith({
            txid: "spent",
            vout: 1,
        });
        expect(pruneForSpentVtxo).toHaveBeenCalledWith({
            txid: "settled",
            vout: 2,
        });
    });

    it("is a no-op when no virtualTxRepository is configured", async () => {
        await expect(
            call({}, [vtxo({ isSpent: true })])
        ).resolves.toBeUndefined();
    });

    it("swallows repository errors (never breaks the sync path)", async () => {
        const pruneForSpentVtxo = vi
            .fn()
            .mockRejectedValue(new Error("backend down"));
        await expect(
            call({ virtualTxRepository: { pruneForSpentVtxo } }, [
                vtxo({ isSpent: true }),
            ])
        ).resolves.toBeUndefined();
        expect(pruneForSpentVtxo).toHaveBeenCalledTimes(1);
    });
});
