import { describe, it, expect, beforeEach, vi } from "vitest";
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
    computeTxid,
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
                return {
                    tapInternalKey: internalKey,
                    tapMerkleRoot: new Uint8Array(32),
                    tapLeafScript: [[controlBlock, new Uint8Array([...leafScript, 0xc0])]],
                };
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
        ).toThrowError(/depth exceeds maximum/);
    });

    /**
     * 2. Ouroboros Attack (Infinite Cycles in DAG)
     * Evaluates protection against A spend B, B spend A cycles.
     */
    it("should immediately detect and reject a cyclic DAG (Ouroboros Attack)", async () => {
        const commitment = fakeCommitmentTxid(0);

        const txA = createVirtualTx(fakeCommitmentTxid(999), 0, [{ amount: 111111n }]);
        const txB = createVirtualTx(fakeCommitmentTxid(888), 0, [{ amount: 222222n }]);
        const fakeRoot = txA.txid;
        const fakeChild = txB.txid;

        const originalBytesA = txA.tx.toBytes(true, false);
        const originalBytesB = txB.tx.toBytes(true, false);

        // Mutate inputs to create a cryptographic cycle artificially
        txA.tx.inputs[0].txid = hex.decode(fakeChild);
        txB.tx.inputs[0].txid = hex.decode(fakeRoot);

        indexer.chain = [
            {
                txid: fakeRoot,
                expiresAt: "2000000000",
                type: ChainTxType.TREE,
                spends: [fakeChild],
            },
            {
                txid: fakeChild,
                expiresAt: "2000000000",
                type: ChainTxType.TREE,
                spends: [fakeRoot],
            },
            { txid: commitment, expiresAt: "3000", type: ChainTxType.COMMITMENT, spends: [] },
        ];

        indexer.virtualTxs.set(fakeRoot, base64.encode(txA.tx.toPSBT()));
        indexer.virtualTxs.set(fakeChild, base64.encode(txB.tx.toPSBT()));

        const originalToBytes = txA.tx.constructor.prototype.toBytes;
        txA.tx.constructor.prototype.toBytes = function (this: any, ...args: any[]) {
            if (this.outputs[0].amount === 111111n) return originalBytesA;
            if (this.outputs[0].amount === 222222n) return originalBytesB;
            return originalToBytes.apply(this, args);
        };

        try {
            await expect(
                reconstructAndValidateVtxoDAG({ txid: fakeRoot, vout: 0 }, indexer, onchain),
            ).rejects.toThrow(/CYCLE_DETECTED/);
        } finally {
            txA.tx.constructor.prototype.toBytes = originalToBytes;
        }
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
            const internalKey = schnorr.getPublicKey(TEST_PRIVKEYS[1]);
            const vTx = createVirtualTx(
                lastTxid,
                0,
                [{ amount: 100000n, script: makeP2TRScript(1) }],
                {
                    tapInternalKey: internalKey,
                    parentScript: makeP2TRScript(1),
                },
            );

            // Ensure the ROOT (first node created) has an INVALID signature
            if (i === 0) {
                vTx.tx.updateInput(0, { tapKeySig: new Uint8Array(64).fill(0xde) });
            } else {
                signVirtualTx(vTx.tx, 0, TEST_PRIVKEYS[1], [
                    { script: makeP2TRScript(1), amount: 100000n },
                ]);
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

        // Should fail on invalid signature
        await expect(verifyVtxoComplete(outpoint, indexer, onchain)).rejects.toThrow(
            /INVALID_SIGNATURE/,
        );
    }, 60000);
});
