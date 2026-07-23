import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { ChainTxType } from "../../src/providers/indexer";
import { Transaction } from "../../src/utils/transaction";
import type { VirtualCoin } from "../../src/wallet";
import { ParsedVtxoProof, verifyClaimedLeaf, verifyGraphSegments } from "../../src/verification";

const COMMITMENT_TXID = "11".repeat(32);
const KEY = schnorr.getPublicKey(new Uint8Array(32).fill(3));
const SCRIPT = Uint8Array.from([0x51, 0x20, ...KEY]);

function makeTx(parentTxid: string, parentVout: number, amounts: bigint[]): Transaction {
    const tx = new Transaction({ allowLegacyWitnessUtxo: true });
    tx.addInput({
        txid: hex.decode(parentTxid),
        index: parentVout,
        witnessUtxo: { amount: amounts.reduce((sum, amount) => sum + amount, 0n), script: SCRIPT },
    });
    for (const amount of amounts) {
        tx.addOutput({ amount, script: SCRIPT });
    }
    return tx;
}

function proofFor(txs: Transaction[]): ParsedVtxoProof {
    const entries = new Map([
        [
            COMMITMENT_TXID,
            {
                txid: COMMITMENT_TXID,
                expiresAt: "0",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ],
        ...txs.map(
            (tx) =>
                [
                    tx.id,
                    {
                        txid: tx.id,
                        expiresAt: "0",
                        type: ChainTxType.TREE,
                        spends: [hex.encode(tx.getInput(0).txid!)],
                    },
                ] as const,
        ),
    ]);
    return {
        entries,
        transactions: new Map(txs.map((tx) => [tx.id, tx])),
        commitmentTxids: [COMMITMENT_TXID],
    };
}

function coin(tx: Transaction, overrides: Partial<VirtualCoin> = {}): VirtualCoin {
    return {
        txid: tx.id,
        vout: 0,
        value: Number(tx.getOutput(0)!.amount),
        script: hex.encode(tx.getOutput(0)!.script!),
        createdAt: new Date(0),
        isUnrolled: false,
        status: { confirmed: false },
        ...overrides,
    };
}

describe("verifyClaimedLeaf", () => {
    const leaf = makeTx(COMMITMENT_TXID, 0, [10_000n]);
    const proof = proofFor([leaf]);

    it("accepts an exact outpoint, amount, and script match", () => {
        expect(verifyClaimedLeaf(coin(leaf), proof)).toEqual([]);
    });

    it("rejects a claimed amount that differs from the output", () => {
        expect(verifyClaimedLeaf(coin(leaf, { value: 10_001 }), proof)[0].code).toBe(
            "leaf_amount_mismatch",
        );
    });

    it("rejects a claimed script that differs from the output", () => {
        expect(verifyClaimedLeaf(coin(leaf, { script: "51" }), proof)[0].code).toBe(
            "leaf_script_mismatch",
        );
    });

    it("rejects a missing output", () => {
        expect(verifyClaimedLeaf(coin(leaf, { vout: 9 }), proof)[0].code).toBe(
            "leaf_output_missing",
        );
    });

    it("rejects a missing transaction", () => {
        expect(verifyClaimedLeaf(coin(leaf, { txid: "44".repeat(32) }), proof)[0].code).toBe(
            "leaf_tx_missing",
        );
    });
});

describe("verifyGraphSegments", () => {
    it("accepts a three-level amount-conserving TREE", () => {
        const root = makeTx(COMMITMENT_TXID, 0, [6_000n, 4_000n]);
        const child = makeTx(root.id, 0, [3_500n, 2_500n]);
        const leaf = makeTx(child.id, 1, [2_500n]);

        expect(verifyGraphSegments(proofFor([leaf, root, child]))).toEqual([]);
    });

    it("rejects a child whose outputs inflate its parent output", () => {
        const root = makeTx(COMMITMENT_TXID, 0, [6_000n, 4_000n]);
        const child = makeTx(root.id, 0, [6_001n]);

        expect(verifyGraphSegments(proofFor([root, child]))[0].code).toBe("graph_amount_mismatch");
    });

    it("rejects two children spending the same parent output", () => {
        const root = makeTx(COMMITMENT_TXID, 0, [10_000n]);
        const left = makeTx(root.id, 0, [9_999n, 1n]);
        const right = makeTx(root.id, 0, [9_998n, 2n]);

        expect(verifyGraphSegments(proofFor([root, left, right]))[0].code).toBe(
            "graph_duplicate_spend",
        );
    });
});
