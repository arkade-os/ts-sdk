import { describe, it, expect, vi } from "vitest";
import { Unroll } from "../src/wallet/unroll";
import { InMemoryVirtualTxRepository } from "../src/repositories/inMemory/virtualTxRepository";
import { ChainTxType } from "../src/providers/indexer";
import { ChainedTxType } from "../src/repositories/virtualTxRepository";

const chainTx = (txid: string, type: ChainTxType) => ({
    txid,
    expiresAt: "",
    type,
    spends: [],
});

function makeSession(repo?: InMemoryVirtualTxRepository) {
    const indexer = {
        getVirtualTxs: vi.fn(async () => ({ txs: ["INDEXER_PSBT"] })),
    } as never;
    const session = new Unroll.Session(
        { txid: "v", vout: 0, chain: [] },
        {} as never,
        {} as never,
        indexer,
        repo,
    );
    return { session, indexer };
}

describe("Unroll.Session repo-first virtual-tx resolution", () => {
    it("returns the stored hex and skips the indexer on a repo hit", async () => {
        const repo = new InMemoryVirtualTxRepository();
        await repo.upsertVirtualTxs([
            {
                txid: "t1",
                hex: "REPO_PSBT",
                expiresAt: null,
                type: ChainedTxType.Ark,
            },
        ]);
        const { session, indexer } = makeSession(repo);

        const psbt = await (
            session as never as {
                resolveVirtualTxBase64: (c: unknown) => Promise<string | undefined>;
            }
        ).resolveVirtualTxBase64(chainTx("t1", ChainTxType.ARK));

        expect(psbt).toBe("REPO_PSBT");
        expect(indexer.getVirtualTxs).not.toHaveBeenCalled();
    });

    it("falls back to the indexer on a miss and caches the result with mapped type", async () => {
        const repo = new InMemoryVirtualTxRepository();
        const { session, indexer } = makeSession(repo);

        const psbt = await (
            session as never as {
                resolveVirtualTxBase64: (c: unknown) => Promise<string | undefined>;
            }
        ).resolveVirtualTxBase64(chainTx("t2", ChainTxType.TREE));

        expect(psbt).toBe("INDEXER_PSBT");
        expect(indexer.getVirtualTxs).toHaveBeenCalledTimes(1);
        const cached = await repo.getVirtualTx("t2");
        expect(cached).toEqual({
            txid: "t2",
            hex: "INDEXER_PSBT",
            expiresAt: null,
            type: ChainedTxType.Tree,
        });
    });

    it("works with no repository (indexer only, no throw)", async () => {
        const { session, indexer } = makeSession(undefined);
        const psbt = await (
            session as never as {
                resolveVirtualTxBase64: (c: unknown) => Promise<string | undefined>;
            }
        ).resolveVirtualTxBase64(chainTx("t3", ChainTxType.ARK));
        expect(psbt).toBe("INDEXER_PSBT");
        expect(indexer.getVirtualTxs).toHaveBeenCalledTimes(1);
    });
});
