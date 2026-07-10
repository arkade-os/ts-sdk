import { describe, expect, it, vi } from "vitest";
import { resolveExplicitOutpointVtxos } from "../src/wallet/exit/estimate";
import { FetchError } from "../src/utils/fetch";
import type { Wallet } from "../src/wallet/wallet";

const OP_A = { txid: "aa".repeat(32), vout: 0 };
const OP_B = { txid: "bb".repeat(32), vout: 1 };

// Minimal VTXO row shape the resolver returns / the caller reads.
function vtxo(op: { txid: string; vout: number }, over: Record<string, unknown> = {}) {
    return {
        txid: op.txid,
        vout: op.vout,
        value: 50_000,
        script: "5120aa",
        isSpent: false,
        ...over,
    };
}

function mockWallet(over: Partial<{ indexerGetVtxos: any; getVtxos: any }> = {}): Wallet {
    return {
        indexerProvider: {
            getVtxos: over.indexerGetVtxos ?? vi.fn().mockResolvedValue({ vtxos: [] }),
        },
        getVtxos: over.getVtxos ?? vi.fn().mockResolvedValue([]),
    } as unknown as Wallet;
}

describe("resolveExplicitOutpointVtxos", () => {
    it("returns the indexer result when online", async () => {
        const wallet = mockWallet({
            indexerGetVtxos: vi.fn().mockResolvedValue({ vtxos: [vtxo(OP_A)] }),
        });
        const out = await resolveExplicitOutpointVtxos(wallet, [OP_A]);
        expect(out.map((v) => `${v.txid}:${v.vout}`)).toEqual([`${OP_A.txid}:0`]);
    });

    it("falls back to cached VTXOs (filtered to the outpoints) on a FetchError", async () => {
        const wallet = mockWallet({
            indexerGetVtxos: vi
                .fn()
                .mockRejectedValue(new FetchError("down", { url: "u", method: "GET" })),
            // repo cache holds A (wanted) and B (not wanted)
            getVtxos: vi.fn().mockResolvedValue([vtxo(OP_A), vtxo(OP_B)]),
        });
        const out = await resolveExplicitOutpointVtxos(wallet, [OP_A]);
        expect(out.map((v) => `${v.txid}:${v.vout}`)).toEqual([`${OP_A.txid}:0`]);
    });

    it("propagates a non-network error", async () => {
        const wallet = mockWallet({
            indexerGetVtxos: vi.fn().mockRejectedValue(new Error("malformed response")),
        });
        await expect(resolveExplicitOutpointVtxos(wallet, [OP_A])).rejects.toThrow(
            "malformed response",
        );
    });
});
