import { base64, hex } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { ChainTx, ChainTxType } from "../src/providers/indexer";
import { InMemoryVirtualTxRepository } from "../src/repositories/inMemory/virtualTxRepository";
import { ChainedTxType } from "../src/repositories/virtualTxRepository";
import { Transaction } from "../src/utils/transaction";
import { captureExitBranch, pruneExitBranches } from "../src/wallet/exit/capture";
import { ExitChainResolver } from "../src/wallet/exit/resolver";

const ROOT = "c0".repeat(32);

// A PSBT spending `parent:0`; its own id becomes the leaf txid the chain uses.
function leaf(parent: string): { psbt: string; txid: string } {
    const t = new Transaction({ version: 2 });
    t.addInput({
        txid: hex.decode(parent),
        index: 0,
        witnessUtxo: { script: hex.decode("0014" + "00".repeat(20)), amount: 1000n },
    });
    const psbt = base64.encode(t.toPSBT());
    return { psbt, txid: t.id };
}

function fakeResolver(
    chains: Record<string, ChainTx[]>,
    psbts: Record<string, string>,
): ExitChainResolver {
    return {
        getVtxoChain: async (vtxo) => chains[`${vtxo.txid}:${vtxo.vout}`] ?? [],
        getVirtualTxs: async (txids) => txids.map((t) => psbts[t]).filter(Boolean),
    };
}

describe("captureExitBranch", () => {
    it("Full: stores the branch with PSBTs, ordered root-first", async () => {
        const repo = new InMemoryVirtualTxRepository();
        const l = leaf(ROOT);
        const chain: ChainTx[] = [
            { txid: l.txid, type: ChainTxType.ARK, expiresAt: "5", spends: [ROOT] },
            { txid: ROOT, type: ChainTxType.COMMITMENT, expiresAt: "", spends: [] },
        ];
        const resolver = fakeResolver({ "bb:0": chain }, { [l.txid]: l.psbt });
        await captureExitBranch({
            resolver,
            repository: repo,
            vtxo: { txid: "bb", vout: 0 },
            value: 50000,
            mode: "full",
            minExitWorthSats: 1000,
        });
        const stored = await repo.getBranch({ txid: "bb", vout: 0 });
        expect(stored.map((v) => v.txid)).toEqual([ROOT, l.txid]); // position 0 = root
        expect(stored.find((v) => v.txid === l.txid)!.psbt).toBe(l.psbt);
        expect(stored.find((v) => v.txid === ROOT)!.psbt).toBeNull();
    });

    it("Lite: stores structure only (null PSBTs)", async () => {
        const repo = new InMemoryVirtualTxRepository();
        const l = leaf(ROOT);
        const chain: ChainTx[] = [
            { txid: l.txid, type: ChainTxType.ARK, expiresAt: "5", spends: [ROOT] },
            { txid: ROOT, type: ChainTxType.COMMITMENT, expiresAt: "", spends: [] },
        ];
        const getVirtualTxs = vi.fn(async () => [] as string[]);
        const resolver = { getVtxoChain: async () => chain, getVirtualTxs } as ExitChainResolver;
        await captureExitBranch({
            resolver,
            repository: repo,
            vtxo: { txid: "bb", vout: 0 },
            value: 50000,
            mode: "lite",
            minExitWorthSats: 1000,
        });
        expect(getVirtualTxs).not.toHaveBeenCalled(); // Lite never fetches PSBTs
        const stored = await repo.getBranch({ txid: "bb", vout: 0 });
        expect(stored.every((v) => v.psbt === null)).toBe(true);
    });

    it("skips dust below minExitWorthSats", async () => {
        const repo = new InMemoryVirtualTxRepository();
        await captureExitBranch({
            resolver: fakeResolver({}, {}),
            repository: repo,
            vtxo: { txid: "bb", vout: 0 },
            value: 500,
            mode: "full",
            minExitWorthSats: 1000,
        });
        expect(await repo.hasBranch({ txid: "bb", vout: 0 })).toBe(false);
    });

    it("is idempotent: skips fetching when a branch already exists", async () => {
        const repo = new InMemoryVirtualTxRepository();
        await repo.setBranch({ txid: "bb", vout: 0 }, [
            { vtxoTxid: "bb", vtxoVout: 0, virtualTxid: ROOT, position: 0 },
        ]);
        const getVtxoChain = vi.fn(async () => [] as ChainTx[]);
        const resolver = { getVtxoChain, getVirtualTxs: async () => [] } as ExitChainResolver;
        await captureExitBranch({
            resolver,
            repository: repo,
            vtxo: { txid: "bb", vout: 0 },
            value: 50000,
            mode: "full",
            minExitWorthSats: 1000,
        });
        expect(getVtxoChain).not.toHaveBeenCalled();
    });
});

describe("pruneExitBranches", () => {
    it("drops the spent VTXO's branch and ref-counted orphans, keeping shared ancestors", async () => {
        const repo = new InMemoryVirtualTxRepository();
        const shared = "a1".repeat(32);
        const uniqueA = "a2".repeat(32);
        const uniqueB = "b2".repeat(32);
        await repo.upsertVirtualTxs([
            { txid: shared, psbt: "s", expiresAt: null, type: ChainedTxType.Tree },
            { txid: uniqueA, psbt: "a", expiresAt: null, type: ChainedTxType.Ark },
            { txid: uniqueB, psbt: "b", expiresAt: null, type: ChainedTxType.Ark },
        ]);
        await repo.setBranch({ txid: "aa", vout: 0 }, [
            { vtxoTxid: "aa", vtxoVout: 0, virtualTxid: shared, position: 0 },
            { vtxoTxid: "aa", vtxoVout: 0, virtualTxid: uniqueA, position: 1 },
        ]);
        await repo.setBranch({ txid: "bb", vout: 0 }, [
            { vtxoTxid: "bb", vtxoVout: 0, virtualTxid: shared, position: 0 },
            { vtxoTxid: "bb", vtxoVout: 0, virtualTxid: uniqueB, position: 1 },
        ]);

        await pruneExitBranches(repo, [{ txid: "aa", vout: 0 }]);

        expect(await repo.hasBranch({ txid: "aa", vout: 0 })).toBe(false);
        expect(await repo.getVirtualTx(uniqueA)).toBeNull(); // orphan collected
        expect((await repo.getVirtualTx(shared))?.txid).toBe(shared); // still referenced by bb
        expect((await repo.getVirtualTx(uniqueB))?.txid).toBe(uniqueB);
    });
});
