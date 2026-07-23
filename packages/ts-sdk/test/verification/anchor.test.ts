import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { ChainTxType } from "../../src/providers/indexer";
import { Transaction } from "../../src/utils/transaction";
import {
    ParsedVtxoProof,
    verifyCommitmentAnchors,
    VtxoChainSource,
    VtxoVerificationUnavailableError,
} from "../../src/verification";

const SCRIPT = Uint8Array.from([0x51, 0x20, ...schnorr.getPublicKey(new Uint8Array(32).fill(4))]);

function fixture(overrides?: {
    witnessAmount?: bigint;
    witnessScript?: Uint8Array;
    status?: Awaited<ReturnType<VtxoChainSource["getTxStatus"]>>;
    tipHeight?: number;
    outspend?: { spent: boolean; txid?: string };
}) {
    const commitment = new Transaction({
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
    });
    commitment.addInput({ txid: new Uint8Array(32).fill(1), index: 0 });
    commitment.addOutput({ amount: 10_000n, script: SCRIPT });

    const tree = new Transaction({ allowLegacyWitnessUtxo: true });
    tree.addInput({
        txid: hex.decode(commitment.id),
        index: 0,
        witnessUtxo: {
            amount: overrides?.witnessAmount ?? 10_000n,
            script: overrides?.witnessScript ?? SCRIPT,
        },
    });
    tree.addOutput({ amount: 10_000n, script: SCRIPT });

    const proof: ParsedVtxoProof = {
        entries: new Map([
            [
                commitment.id,
                {
                    txid: commitment.id,
                    expiresAt: "0",
                    type: ChainTxType.COMMITMENT,
                    spends: [],
                },
            ],
            [
                tree.id,
                {
                    txid: tree.id,
                    expiresAt: "0",
                    type: ChainTxType.TREE,
                    spends: [commitment.id],
                },
            ],
        ]),
        transactions: new Map([[tree.id, tree]]),
        commitmentTxids: [commitment.id],
    };
    const source: VtxoChainSource = {
        getTxHex: async () => commitment.hex,
        getTxStatus: async () =>
            overrides?.status ?? { confirmed: true, blockHeight: 100, blockTime: 1 },
        getChainTip: async () => ({
            height: overrides?.tipHeight ?? 105,
            time: 2,
            hash: "00".repeat(32),
        }),
        getTxOutspends: async () => [overrides?.outspend ?? { spent: false }],
    };
    return { commitment, tree, proof, source };
}

describe("verifyCommitmentAnchors", () => {
    it("accepts a matching raw commitment at the required depth", async () => {
        const { proof, source } = fixture();
        await expect(verifyCommitmentAnchors(proof, source, 6)).resolves.toEqual({
            confirmationDepth: 6,
            issues: [],
        });
    });

    it("rejects a commitment amount mismatch", async () => {
        const { proof, source } = fixture({ witnessAmount: 9_999n });
        const result = await verifyCommitmentAnchors(proof, source, 6);
        expect(result.issues[0].code).toBe("anchor_amount_mismatch");
    });

    it("rejects a commitment script mismatch", async () => {
        const otherScript = Uint8Array.from([
            0x51,
            0x20,
            ...schnorr.getPublicKey(new Uint8Array(32).fill(5)),
        ]);
        const { proof, source } = fixture({ witnessScript: otherScript });
        const result = await verifyCommitmentAnchors(proof, source, 6);
        expect(result.issues[0].code).toBe("anchor_script_mismatch");
    });

    it("rejects insufficient confirmation depth", async () => {
        const { proof, source } = fixture({ tipHeight: 104 });
        const result = await verifyCommitmentAnchors(proof, source, 6);
        expect(result.issues[0].code).toBe("anchor_depth_insufficient");
    });

    it("accepts an expected root transaction outspend", async () => {
        const initial = fixture();
        const { proof, source } = fixture({
            outspend: { spent: true, txid: initial.tree.id },
        });
        const rootTxid = [...proof.transactions.keys()][0];
        source.getTxOutspends = async () => [{ spent: true, txid: rootTxid }];

        expect((await verifyCommitmentAnchors(proof, source, 6)).issues).toEqual([]);
    });

    it("rejects an unexpected commitment outspend", async () => {
        const { proof, source } = fixture({
            outspend: { spent: true, txid: "66".repeat(32) },
        });
        const result = await verifyCommitmentAnchors(proof, source, 6);
        expect(result.issues[0].code).toBe("anchor_unexpected_spend");
    });

    it("classifies chain-source failure as unavailable", async () => {
        const { proof, source } = fixture();
        source.getTxHex = async () => {
            throw new Error("chain offline");
        };

        await expect(verifyCommitmentAnchors(proof, source, 6)).rejects.toBeInstanceOf(
            VtxoVerificationUnavailableError,
        );
    });
});
