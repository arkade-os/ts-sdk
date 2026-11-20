import { base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_SIZE } from "../src/contracts/constants";
import { ChainTx, ChainTxType } from "../src/providers/indexer";
import { Transaction } from "../src/utils/transaction";
import { IndexerExitDataSource } from "../src/wallet/exit/indexerSource";

const tx = (txid: string): ChainTx => ({
    txid,
    expiresAt: "0",
    type: ChainTxType.ARK,
    spends: [],
});

// A tiny valid PSBT so getVirtualTxs can derive an id from it.
function emptyPsbtBase64(): { psbt: string; id: string } {
    const t = new Transaction({ version: 2 });
    return { psbt: base64.encode(t.toPSBT()), id: t.id };
}

function fakeIndexer(
    pages: { chain: ChainTx[]; page?: any }[],
    psbtsByTxid: Record<string, string>,
) {
    return {
        // As arkd: index 0 serves page 1.
        getVtxoChain: async (_o: any, opts: any) =>
            pages[Math.max(opts.pageIndex, 1) - 1] ?? { chain: [] },
        getVirtualTxs: async (txids: string[]) => ({
            txs: txids.map((t) => psbtsByTxid[t]).filter(Boolean),
        }),
    } as any;
}

// Full pages under a caller-chosen cursor; throws past `limit` so a walk that never ends fails fast.
function pagedIndexer(page: (pageIndex: number) => object, limit: number) {
    const full = Array.from({ length: DEFAULT_PAGE_SIZE }, (_, i) => tx(`p_${i}`));
    const indexer = {
        calls: 0,
        getVtxoChain: async (_o: unknown, opts: { pageIndex: number }) => {
            if (++indexer.calls > limit) throw new Error("no more pages");
            return { chain: full, page: page(opts.pageIndex) };
        },
    };
    return indexer;
}

describe("IndexerExitDataSource", () => {
    it("returns a single-page chain", async () => {
        const source = new IndexerExitDataSource(fakeIndexer([{ chain: [tx("a"), tx("b")] }], {}));
        const chain = await source.getVtxoChain({ txid: "aa", vout: 0 });
        expect(chain!.map((c) => c.txid)).toEqual(["a", "b"]);
    });

    it("follows the indexer's cursor past a page capped at 100 entries", async () => {
        const full = Array.from({ length: 100 }, (_, i) => tx(`p0_${i}`));
        const indexer = fakeIndexer(
            [
                { chain: full, page: { current: 1, next: 2, total: 2 } },
                { chain: [tx("leaf")], page: { current: 2, next: 2, total: 2 } },
            ],
            {},
        );
        const chain = await new IndexerExitDataSource(indexer).getVtxoChain({
            txid: "aa",
            vout: 0,
        });
        expect(chain!.length).toBe(101);
        expect(chain![chain!.length - 1].txid).toBe("leaf");
    });

    it("stops when the indexer's cursor stops advancing", async () => {
        const indexer = pagedIndexer(() => ({ current: 1, next: 1, total: 2 }), 3);
        await new IndexerExitDataSource(indexer as any).getVtxoChain({ txid: "aa", vout: 0 });
        expect(indexer.calls).toBe(2);
    });

    it("gives up after 1000 pages", async () => {
        const indexer = pagedIndexer((i) => ({ current: i + 1, next: i + 2, total: 1e9 }), 1000);
        const walk = new IndexerExitDataSource(indexer as any).getVtxoChain({
            txid: "aa",
            vout: 0,
        });
        await expect(walk).rejects.toThrow("indexer paging does not end");
        expect(indexer.calls).toBe(1000);
    });

    it("keys PSBTs by their derived (unsigned) txid", async () => {
        const { psbt, id } = emptyPsbtBase64();
        const source = new IndexerExitDataSource(fakeIndexer([], { [id]: psbt }));
        const got = await source.getVirtualTxs([id]);
        expect(got.get(id)).toBe(psbt);
    });
});
