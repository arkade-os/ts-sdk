import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { ChainTx, ChainTxType } from "../../src/providers/indexer";
import { Transaction } from "../../src/utils/transaction";
import { parseVtxoProof, VtxoProofError, VtxoProofSource } from "../../src/verification";

const COMMITMENT_TXID = "11".repeat(32);
const INPUT_KEY = schnorr.getPublicKey(new Uint8Array(32).fill(2));
const OUTPUT_KEY = schnorr.getPublicKey(new Uint8Array(32).fill(3));

function makeTreePsbt(parentTxid = COMMITMENT_TXID): { psbt: string; txid: string } {
    const tx = new Transaction({ allowLegacyWitnessUtxo: true });
    tx.addInput({
        txid: hex.decode(parentTxid),
        index: 0,
        witnessUtxo: {
            amount: 10_000n,
            script: Uint8Array.from([0x51, 0x20, ...INPUT_KEY]),
        },
    });
    tx.addOutput({
        amount: 10_000n,
        script: Uint8Array.from([0x51, 0x20, ...OUTPUT_KEY]),
    });
    return { psbt: base64.encode(tx.toPSBT()), txid: tx.id };
}

function makeChain(treeTxid: string, spends = [COMMITMENT_TXID]): ChainTx[] {
    return [
        {
            txid: COMMITMENT_TXID,
            expiresAt: "0",
            type: ChainTxType.COMMITMENT,
            spends: [],
        },
        {
            txid: treeTxid,
            expiresAt: "0",
            type: ChainTxType.TREE,
            spends,
        },
    ];
}

function source(chain: ChainTx[], psbts: string[]): VtxoProofSource {
    return {
        getVtxoChain: async () => chain,
        getVirtualTxs: async () => psbts,
    };
}

describe("parseVtxoProof", () => {
    it("parses virtual PSBTs and commitment ancestry without trusting order", async () => {
        const tree = makeTreePsbt();
        const proof = await parseVtxoProof(
            { txid: tree.txid, vout: 0 },
            source(makeChain(tree.txid), [tree.psbt]),
        );

        expect(proof.commitmentTxids).toEqual([COMMITMENT_TXID]);
        expect(proof.transactions.get(tree.txid)?.id).toBe(tree.txid);
        expect(proof.entries.get(tree.txid)?.spends).toEqual([COMMITMENT_TXID]);
    });

    it("normalizes metadata transaction identifiers before comparison", async () => {
        const tree = makeTreePsbt();
        const chain = makeChain(tree.txid).map((entry) => ({
            ...entry,
            txid: entry.txid.toUpperCase(),
            spends: entry.spends.map((txid) => txid.toUpperCase()),
        }));

        const proof = await parseVtxoProof(
            { txid: tree.txid.toUpperCase(), vout: 0 },
            source(chain, [tree.psbt]),
        );

        expect(proof.entries.has(tree.txid)).toBe(true);
        expect(proof.entries.get(tree.txid)?.spends).toEqual([COMMITMENT_TXID]);
        expect(proof.commitmentTxids).toEqual([COMMITMENT_TXID]);
    });

    it("rejects duplicate metadata identifiers that differ only by case", async () => {
        const tree = makeTreePsbt();
        const chain = makeChain(tree.txid);
        chain.push({ ...chain[1], txid: tree.txid.toUpperCase() });

        await expect(
            parseVtxoProof({ txid: tree.txid, vout: 0 }, source(chain, [tree.psbt])),
        ).rejects.toMatchObject<VtxoProofError>({
            code: "proof_duplicate_txid",
            kind: "invalid",
        });
    });

    it("rejects metadata nodes disconnected from the requested outpoint", async () => {
        const tree = makeTreePsbt();
        const unrelatedCommitment = "22".repeat(32);
        const chain = [
            ...makeChain(tree.txid),
            {
                txid: unrelatedCommitment,
                expiresAt: "0",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];

        await expect(
            parseVtxoProof({ txid: tree.txid, vout: 0 }, source(chain, [tree.psbt])),
        ).rejects.toMatchObject<VtxoProofError>({
            code: "proof_disconnected_node",
            kind: "invalid",
        });
    });

    it("classifies a missing PSBT as unavailable", async () => {
        const tree = makeTreePsbt();

        await expect(
            parseVtxoProof({ txid: tree.txid, vout: 0 }, source(makeChain(tree.txid), [])),
        ).rejects.toMatchObject<VtxoProofError>({
            code: "proof_psbt_missing",
            kind: "unavailable",
        });
    });

    it("rejects a PSBT whose recomputed txid is not declared", async () => {
        const tree = makeTreePsbt();
        const other = makeTreePsbt("22".repeat(32));

        await expect(
            parseVtxoProof(
                { txid: tree.txid, vout: 0 },
                source(makeChain(tree.txid), [other.psbt]),
            ),
        ).rejects.toMatchObject<VtxoProofError>({
            code: "proof_psbt_txid_mismatch",
            kind: "invalid",
        });
    });

    it("rejects metadata parents that differ from transaction inputs", async () => {
        const tree = makeTreePsbt();

        await expect(
            parseVtxoProof(
                { txid: tree.txid, vout: 0 },
                source(makeChain(tree.txid, ["33".repeat(32)]), [tree.psbt]),
            ),
        ).rejects.toMatchObject<VtxoProofError>({
            code: "proof_parent_mismatch",
            kind: "invalid",
        });
    });

    it("rejects conflicting duplicate chain entries", async () => {
        const tree = makeTreePsbt();
        const chain = makeChain(tree.txid);
        chain.push({ ...chain[1], type: ChainTxType.ARK });

        await expect(
            parseVtxoProof({ txid: tree.txid, vout: 0 }, source(chain, [tree.psbt])),
        ).rejects.toMatchObject<VtxoProofError>({
            code: "proof_duplicate_txid",
            kind: "invalid",
        });
    });

    it("classifies proof-source transport failure as unavailable", async () => {
        const failing: VtxoProofSource = {
            getVtxoChain: async () => {
                throw new Error("indexer offline");
            },
            getVirtualTxs: async () => [],
        };

        await expect(
            parseVtxoProof({ txid: "44".repeat(32), vout: 0 }, failing),
        ).rejects.toMatchObject<VtxoProofError>({
            code: "proof_chain_unavailable",
            kind: "unavailable",
        });
    });
});
