import { describe, expect, it } from "vitest";
import {
    createExitChainResolver,
    verifyVtxo,
    type VtxoProofSource,
    type VtxoVerificationResult,
} from "../../src";

describe("verification public API", () => {
    it("exports verifyVtxo from the package root", () => {
        expect(typeof verifyVtxo).toBe("function");
    });

    it("keeps ExitChainResolver structurally compatible with VtxoProofSource", () => {
        const indexer = {
            getVtxoChain: async () => ({ chain: [] }),
            getVirtualTxs: async () => ({ txs: [] }),
        };
        const source: VtxoProofSource = createExitChainResolver({
            indexer: indexer as never,
        });
        expect(source).toBeDefined();
    });

    it("exposes the discriminated result type", () => {
        const result: VtxoVerificationResult = {
            status: "invalid",
            outpoint: { txid: "00".repeat(32), vout: 0 },
            commitmentTxids: [],
            chainLength: 0,
            issues: [],
        };
        expect(result.status).toBe("invalid");
    });
});
