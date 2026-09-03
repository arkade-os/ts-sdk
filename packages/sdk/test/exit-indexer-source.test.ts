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
        getVtxoChain: async (_o: any, opts: any) => pages[opts.pageIndex] ?? { chain: [] },
        getVirtualTxs: async (txids: string[]) => ({
            txs: txids.map((t) => psbtsByTxid[t]).filter(Boolean),
        }),
    } as any;
}

describe("IndexerExitDataSource", () => {
    it("returns a single-page chain", async () => {
        const source = new IndexerExitDataSource(fakeIndexer([{ chain: [tx("a"), tx("b")] }], {}));
        const chain = await source.getVtxoChain({ txid: "aa", vout: 0 });
        expect(chain!.map((c) => c.txid)).toEqual(["a", "b"]);
    });

    it("walks and merges all pages until a short page", async () => {
        // A full page (== DEFAULT_PAGE_SIZE) signals "there may be more" → fetch page 1;
        // the short page 1 ends it.
        const full = Array.from({ length: DEFAULT_PAGE_SIZE }, (_, i) => tx(`p0_${i}`));
        const indexer = fakeIndexer(
            [
                { chain: full, page: { current: 0, next: 1, total: 2 } },
                { chain: [tx("leaf")], page: { current: 1, next: 1, total: 2 } },
            ],
            {},
        );
        const chain = await new IndexerExitDataSource(indexer).getVtxoChain({
            txid: "aa",
            vout: 0,
        });
        expect(chain!.length).toBe(DEFAULT_PAGE_SIZE + 1);
        expect(chain![chain!.length - 1].txid).toBe("leaf");
    });

    it("keys PSBTs by their derived (unsigned) txid", async () => {
        const { psbt, id } = emptyPsbtBase64();
        const source = new IndexerExitDataSource(fakeIndexer([], { [id]: psbt }));
        const got = await source.getVirtualTxs([id]);
        expect(got.get(id)).toBe(psbt);
    });
});
