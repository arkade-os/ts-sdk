import { describe, expect, it, vi } from "vitest";
import { ExitDataSource, OrderedExitChainResolver } from "../src/wallet/exit/resolver";
import { ChainTx, ChainTxType } from "../src/providers/indexer";

const chainTx = (txid: string): ChainTx => ({
    txid,
    expiresAt: "0",
    type: ChainTxType.ARK,
    spends: [],
});

// A fake source that answers only the keys it was seeded with.
function fakeSource(
    name: string,
    chains: Record<string, ChainTx[]>,
    psbts: Record<string, string>,
): ExitDataSource {
    return {
        name,
        getVtxoChain: async (vtxo) => chains[`${vtxo.txid}:${vtxo.vout}`] ?? null,
        getVirtualTxs: async (txids) => {
            const out = new Map<string, string>();
            for (const t of txids) if (psbts[t]) out.set(t, psbts[t]);
            return out;
        },
    };
}

describe("OrderedExitChainResolver", () => {
    it("returns the first source that resolves the chain", async () => {
        const local = fakeSource("local", {}, {});
        const indexer = fakeSource("indexer", { "aa:0": [chainTx("t1")] }, {});
        const r = new OrderedExitChainResolver([local, indexer]);
        expect((await r.getVtxoChain({ txid: "aa", vout: 0 })).map((c) => c.txid)).toEqual(["t1"]);
    });

    it("merges partial PSBT hits across sources, local first", async () => {
        const local = fakeSource("local", {}, { t1: "psbt1" });
        const indexer = fakeSource("indexer", {}, { t1: "IGNORED", t2: "psbt2" });
        const r = new OrderedExitChainResolver([local, indexer]);
        const txs = await r.getVirtualTxs(["t1", "t2"]);
        expect(new Set(txs)).toEqual(new Set(["psbt1", "psbt2"]));
    });

    it("read-through persists non-local PSBT hits, best-effort", async () => {
        const persist = { upsertVirtualTxs: vi.fn(async () => {}) } as any;
        const local = fakeSource("local", {}, {});
        const indexer = fakeSource("indexer", {}, { t2: "psbt2" });
        const r = new OrderedExitChainResolver([local, indexer], persist);
        await r.getVirtualTxs(["t2"]);
        expect(persist.upsertVirtualTxs).toHaveBeenCalledOnce();
        expect(persist.upsertVirtualTxs.mock.calls[0][0]).toEqual([
            { txid: "t2", psbt: "psbt2", expiresAt: null, type: 0 },
        ]);
    });

    it("rethrows the last source error when nothing resolves the chain", async () => {
        const throwing: ExitDataSource = {
            name: "indexer",
            getVtxoChain: async () => {
                throw new Error("indexer down");
            },
            getVirtualTxs: async () => new Map(),
        };
        const r = new OrderedExitChainResolver([throwing]);
        await expect(r.getVtxoChain({ txid: "aa", vout: 0 })).rejects.toThrow(/indexer down/);
    });
});
