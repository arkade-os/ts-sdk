import { describe, it, expect } from "vitest";
import {
    VirtualTxRepository,
    VirtualTx,
    ChainedTxType,
} from "../../src/repositories/virtualTxRepository";

const tx = (txid: string, over: Partial<VirtualTx> = {}): VirtualTx => ({
    txid,
    hex: `aa${txid}`,
    expiresAt: 1000,
    type: ChainedTxType.Ark,
    ...over,
});

/**
 * Run the VirtualTxRepository contract against a backend.
 * @param make returns a fresh, empty repository per call.
 */
export function virtualTxRepositoryConformance(
    name: string,
    make: () => Promise<VirtualTxRepository>,
): void {
    describe(`VirtualTxRepository conformance: ${name}`, () => {
        it("round-trips a virtual tx", async () => {
            const r = await make();
            await r.upsertVirtualTxs([tx("a")]);
            expect(await r.getVirtualTx("a")).toEqual(tx("a"));
            expect(await r.getVirtualTx("missing")).toBeNull();
        });

        it("upsert merges non-null fields and preserves existing on null", async () => {
            const r = await make();
            await r.upsertVirtualTxs([tx("a", { hex: "old", expiresAt: 5 })]);
            await r.upsertVirtualTxs([
                {
                    txid: "a",
                    hex: null,
                    expiresAt: 9,
                    type: ChainedTxType.Tree,
                },
            ]);
            const got = await r.getVirtualTx("a");
            expect(got).toEqual({
                txid: "a",
                hex: "old", // null incoming preserved existing
                expiresAt: 9, // non-null incoming overwrote
                type: ChainedTxType.Tree,
            });
        });

        it("setBranch replaces, getBranch returns txs ordered by position", async () => {
            const r = await make();
            await r.upsertVirtualTxs([tx("root"), tx("mid"), tx("leaf")]);
            await r.setBranch({ txid: "v", vout: 0 }, [
                {
                    vtxoTxid: "v",
                    vtxoVout: 0,
                    virtualTxid: "leaf",
                    position: 2,
                },
                {
                    vtxoTxid: "v",
                    vtxoVout: 0,
                    virtualTxid: "root",
                    position: 0,
                },
                {
                    vtxoTxid: "v",
                    vtxoVout: 0,
                    virtualTxid: "mid",
                    position: 1,
                },
            ]);
            expect((await r.getBranch({ txid: "v", vout: 0 })).map((t) => t.txid)).toEqual([
                "root",
                "mid",
                "leaf",
            ]);
            expect(await r.hasBranch({ txid: "v", vout: 0 })).toBe(true);
            expect(await r.hasBranch({ txid: "v", vout: 1 })).toBe(false);

            await r.setBranch({ txid: "v", vout: 0 }, [
                {
                    vtxoTxid: "v",
                    vtxoVout: 0,
                    virtualTxid: "root",
                    position: 0,
                },
            ]);
            expect((await r.getBranch({ txid: "v", vout: 0 })).map((t) => t.txid)).toEqual([
                "root",
            ]);
        });

        it("pruneForSpentVtxo drops branch rows and orphaned txs only", async () => {
            const r = await make();
            await r.upsertVirtualTxs([tx("shared"), tx("only")]);
            await r.setBranch({ txid: "v1", vout: 0 }, [
                {
                    vtxoTxid: "v1",
                    vtxoVout: 0,
                    virtualTxid: "shared",
                    position: 0,
                },
                {
                    vtxoTxid: "v1",
                    vtxoVout: 0,
                    virtualTxid: "only",
                    position: 1,
                },
            ]);
            await r.setBranch({ txid: "v2", vout: 0 }, [
                {
                    vtxoTxid: "v2",
                    vtxoVout: 0,
                    virtualTxid: "shared",
                    position: 0,
                },
            ]);
            await r.pruneForSpentVtxo({ txid: "v1", vout: 0 });
            expect(await r.hasBranch({ txid: "v1", vout: 0 })).toBe(false);
            expect(await r.getVirtualTx("only")).toBeNull(); // orphan removed
            expect(await r.getVirtualTx("shared")).not.toBeNull(); // still referenced by v2
        });

        it("pruneForSpentVtxo is idempotent when repeated", async () => {
            const r = await make();
            await r.upsertVirtualTxs([tx("a"), tx("b")]);
            await r.setBranch({ txid: "v1", vout: 0 }, [
                { vtxoTxid: "v1", vtxoVout: 0, virtualTxid: "a", position: 0 },
                { vtxoTxid: "v1", vtxoVout: 0, virtualTxid: "b", position: 1 },
            ]);
            await r.pruneForSpentVtxo({ txid: "v1", vout: 0 });
            // Second prune of the same (already-gone) vtxo must not throw.
            await expect(r.pruneForSpentVtxo({ txid: "v1", vout: 0 })).resolves.toBeUndefined();
            expect(await r.hasBranch({ txid: "v1", vout: 0 })).toBe(false);
            expect(await r.getVirtualTx("a")).toBeNull();
            expect(await r.getVirtualTx("b")).toBeNull();
        });

        it("clear empties the store", async () => {
            const r = await make();
            await r.upsertVirtualTxs([tx("a")]);
            await r.clear();
            expect(await r.getVirtualTx("a")).toBeNull();
        });
    });
}
