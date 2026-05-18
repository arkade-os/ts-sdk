import { describe, it, expect } from "vitest";
import {
    chainToBranchAndTxs,
    chainTxTypeToChained,
} from "../src/contracts/contractManager";
import { ChainTxType } from "../src/providers/indexer";
import { ChainedTxType } from "../src/repositories/virtualTxRepository";

describe("chainTxTypeToChained", () => {
    it("maps every indexer chain-tx type", () => {
        expect(chainTxTypeToChained(ChainTxType.COMMITMENT)).toBe(
            ChainedTxType.Commitment
        );
        expect(chainTxTypeToChained(ChainTxType.ARK)).toBe(ChainedTxType.Ark);
        expect(chainTxTypeToChained(ChainTxType.TREE)).toBe(ChainedTxType.Tree);
        expect(chainTxTypeToChained(ChainTxType.CHECKPOINT)).toBe(
            ChainedTxType.Checkpoint
        );
        expect(chainTxTypeToChained(ChainTxType.UNSPECIFIED)).toBe(
            ChainedTxType.Unspecified
        );
    });
});

describe("chainToBranchAndTxs", () => {
    const vtxo = { txid: "v", vout: 0 };
    // Indexer returns leaf-first: index 0 = leaf, last = commitment/root.
    const chain = [
        {
            txid: "leaf",
            expiresAt: "1700000000",
            type: ChainTxType.ARK,
            spends: ["mid"],
        },
        {
            txid: "mid",
            expiresAt: "",
            type: ChainTxType.TREE,
            spends: ["root"],
        },
        {
            txid: "root",
            expiresAt: "",
            type: ChainTxType.COMMITMENT,
            spends: [],
        },
    ];

    it("reverses to commitment-first positions", () => {
        const { branch } = chainToBranchAndTxs(vtxo, chain);
        expect(branch).toEqual([
            { vtxoTxid: "v", vtxoVout: 0, virtualTxid: "leaf", position: 2 },
            { vtxoTxid: "v", vtxoVout: 0, virtualTxid: "mid", position: 1 },
            { vtxoTxid: "v", vtxoVout: 0, virtualTxid: "root", position: 0 },
        ]);
    });

    it("Lite mode leaves hex null; Full mode fills from the map", () => {
        const lite = chainToBranchAndTxs(vtxo, chain);
        expect(lite.txs.every((t) => t.hex === null)).toBe(true);

        const full = chainToBranchAndTxs(
            vtxo,
            chain,
            new Map([["leaf", "AAAA"]])
        );
        expect(full.txs.find((t) => t.txid === "leaf")!.hex).toBe("AAAA");
        expect(full.txs.find((t) => t.txid === "mid")!.hex).toBeNull();
    });

    it("parses unix-seconds expiry to ms epoch; blank to null", () => {
        const { txs } = chainToBranchAndTxs(vtxo, chain);
        expect(txs[0].expiresAt).toBe(1700000000 * 1000);
        expect(txs[1].expiresAt).toBeNull();
        expect(txs[2].type).toBe(ChainedTxType.Commitment);
    });
});
