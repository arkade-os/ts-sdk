import { describe, it, expect, beforeEach } from "vitest";
import { hex, base64 } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    TEST_PRIVKEYS,
    createVirtualTx,
    signVirtualTx,
    fakeCommitmentTxid,
    makeP2TRScript,
    MockIndexerProvider,
    MockOnchainProvider,
} from "./vtxoDAGVerification.test.js";
import {
    verifyVtxoComplete,
    reconstructAndValidateVtxoDAG,
    ChainTxType,
    VtxoVerificationError,
} from "../../src/tree/vtxoDAGVerification.js";
import { verifyDAGSignatures } from "../../src/tree/signatureVerification.js";

describe("Red Team: Stress & DoS Audit", () => {
    let indexer: MockIndexerProvider;
    let onchain: MockOnchainProvider;

    beforeEach(() => {
        indexer = new MockIndexerProvider();
        onchain = new MockOnchainProvider();
    });

    /**
     * 1. The Merkle Bomb (Deep Taproot Tree)
     * Evaluates if the iterative parser handles deep trees without recursion errors.
     */
    it("should resist a 'Merkle Bomb' (1000 level Taproot tree)", async () => {
        const depth = 1000;
        const leafScript = makeP2TRScript(2);
        const internalKey = schnorr.getPublicKey(TEST_PRIVKEYS[1]);
        const controlBlock = new Uint8Array(1 + 32 + depth * 32);
        controlBlock[0] = 0xc0;
        controlBlock.set(internalKey, 1);
        controlBlock.fill(0x01, 33);

        const mockTx = {
            inputsLength: 1,
            getInput: (index: number) => {
                if (index === 0) {
                    return {
                        tapLeafScript: [[controlBlock, leafScript]],
                    };
                }
                return {};
            },
        } as any;

        const { verifyNodeTaproot } = await import("../../src/tree/taprootVerification.js");

        expect(() =>
            verifyNodeTaproot({
                txid: "mock-txid",
                tx: mockTx,
                chainTx: { txid: "mock-txid", type: ChainTxType.TREE, spends: [] } as any,
                children: new Map(),
                ancestor: null,
                ancestorOutputIndex: null,
                descendant: null,
                rawPsbt: "",
            } as any),
        ).toThrow();
    });

    /**
     * 2. Ouroboros Attack (Infinite Cycles in DAG)
     * Evaluates protection against A spend B, B spend A cycles.
     */
    it("should immediately detect and reject a cyclic DAG (Ouroboros Attack)", async () => {
        const commitment = fakeCommitmentTxid(0);

        const txA = "aa".repeat(32);
        const txB = "bb".repeat(32);

        const psbtA = createVirtualTx(txB, 0, [{ amount: 100000n }]).tx.toPSBT();
        const psbtB = createVirtualTx(txA, 0, [{ amount: 100000n }]).tx.toPSBT();

        indexer.chain = [
            { txid: txA, expiresAt: "2000000000", type: ChainTxType.TREE, spends: [txB] },
            { txid: txB, expiresAt: "2000000000", type: ChainTxType.TREE, spends: [txA] },
            { txid: commitment, expiresAt: "2000000000", type: ChainTxType.COMMITMENT, spends: [] },
        ];

        indexer.virtualTxs.set(txA, base64.encode(psbtA));
        indexer.virtualTxs.set(txB, base64.encode(psbtB));

        await expect(
            reconstructAndValidateVtxoDAG({ txid: txA, vout: 0 }, indexer, onchain),
        ).rejects.toThrow();
    });

    /**
     * 3. Signature Flood (CPU Exhaustion attempt)
     * Confirms fail-fast behavior on a large batch of invalid signatures.
     */
    it("should fail-fast on the first invalid signature in a large DAG", async () => {
        const count = 100;
        const commitmentRaw = createVirtualTx(
            "0000000000000000000000000000000000000000000000000000000000000001",
            0,
            [{ amount: 100000n, script: makeP2TRScript(1) }],
        );
        const commitment = commitmentRaw.txid;
        const chain: any[] = [{ txid: commitment, type: ChainTxType.COMMITMENT, spends: [] }];

        let lastTxid = commitment;
        const virtualTxs = new Map<string, string>();

        for (let i = 0; i < count; i++) {
            const vTx = createVirtualTx(lastTxid, 0, [{ amount: 100000n }], {
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
            });

            // Ensure the ROOT (first node created) has an INVALID signature
            if (i === 0) {
                vTx.tx.updateInput(0, { tapKeySig: new Uint8Array(64).fill(0xde) });
            }

            virtualTxs.set(vTx.txid, base64.encode(vTx.tx.toPSBT()));
            chain.unshift({ txid: vTx.txid, type: ChainTxType.TREE, spends: [lastTxid] });
            lastTxid = vTx.txid;
        }

        indexer.chain = chain;
        indexer.virtualTxs = virtualTxs;
        onchain.confirmedTxids.add(commitment);
        onchain.txs.set(commitment, hex.encode(commitmentRaw.tx.toBytes()));

        const outpoint = { txid: lastTxid, vout: 0 };

        // Should fail on invalid signature / root mismatch
        await expect(verifyVtxoComplete(outpoint, indexer, onchain)).rejects.toThrow(
            /INVALID_TAPROOT_TWEAK|INVALID_SIGNATURE/,
        );
    }, 60000);
});
