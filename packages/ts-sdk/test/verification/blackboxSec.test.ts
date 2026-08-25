import { describe, it, expect, beforeEach } from "vitest";
import { hex, base64 } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { p2tr } from "@scure/btc-signer/payment.js";
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
    ChainTxType,
    reconstructAndValidateVtxoDAG,
    verifyVtxoComplete,
    computeTxid,
} from "../../src/tree/vtxoDAGVerification.js";

describe("Black Box Security Audit: Malicious ASP Resilience", () => {
    let indexer: MockIndexerProvider;
    let onchain: MockOnchainProvider;

    beforeEach(() => {
        indexer = new MockIndexerProvider();
        onchain = new MockOnchainProvider();
    });

    // ─── Scenario 1: The Mirage Attack ───────────────────────────────────────
    it("MIRAGE: should reject a VTXO when the commitment transaction is missing on-chain", async () => {
        const commitmentTxid = fakeCommitmentTxid(404); // Not in onchain.txs

        // We create a structural chain metadata, but the root anchor is floating in a mirage
        const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }]);

        indexer.chain = [
            {
                txid: vtxoTx.txid,
                expiresAt: "2000000000",
                type: ChainTxType.ARK,
                spends: [commitmentTxid],
            },
            {
                txid: commitmentTxid,
                expiresAt: "2000000000",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];
        indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

        // The SDK should fail when attempting to fetch the commitment raw hex
        await expect(
            reconstructAndValidateVtxoDAG({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain),
        ).rejects.toThrow(); // Should fail at Step 5a: getRawTransaction
    });

    it("MIRAGE: should reject a VTXO when the commitment is found but NOT confirmed", async () => {
        const commitmentRaw = createVirtualTx(fakeCommitmentTxid(203), 0, [{ amount: 100000n }]);
        const commitmentTxid = commitmentRaw.txid;

        // Found in node, but NOT confirmed
        onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
        // onchain.confirmedTxids.add(commitmentTxid); // OMITTED intentionally

        const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
            parentScript: makeP2TRScript(1),
            tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
        });
        signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[1], [
            { script: makeP2TRScript(1), amount: 100000n },
        ]);

        indexer.chain = [
            {
                txid: vtxoTx.txid,
                expiresAt: "2000000000",
                type: ChainTxType.ARK,
                spends: [commitmentTxid],
            },
            {
                txid: commitmentTxid,
                expiresAt: "2000000000",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];
        indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

        // Use verifyVtxoComplete to trigger the on-chain status check (verifyOnchainAnchoring)
        await expect(
            verifyVtxoComplete({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain, 1),
        ).rejects.toThrow(/COMMITMENT_NOT_CONFIRMED/);
    });

    // ─── Scenario 2: Data Poisoning ──────────────────────────────────────────
    it("POISON: should reject corrupted PSBT data and prevent SDK crash", async () => {
        const commitmentTxid = fakeCommitmentTxid(500);
        const vtxoTxid = "vtxo_poison_01";

        indexer.chain = [
            {
                txid: vtxoTxid,
                expiresAt: "2000000000",
                type: ChainTxType.ARK,
                spends: [commitmentTxid],
            },
            {
                txid: commitmentTxid,
                expiresAt: "2000000000",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];

        // Inject "poison" PSBT - valid base64 but invalid internal structure (just dummy bytes)
        const poisonData = base64.encode(new Uint8Array([0x42, 0x42, 0x42, 0x42, 0x00, 0xff]));
        indexer.virtualTxs.set(vtxoTxid, poisonData);

        // reconstructAndValidateVtxoDAG should catch the decoding error during Transaction.fromPSBT
        await expect(
            reconstructAndValidateVtxoDAG({ txid: vtxoTxid, vout: 0 }, indexer, onchain),
        ).rejects.toThrow();
    });

    // ─── Scenario 3: Checkpoint Forgery ──────────────────────────────────────
    it("FORGERY: should reject Checkpoints with incoherent expiry (expires after parent)", async () => {
        const commitmentRaw = createVirtualTx(fakeCommitmentTxid(601), 0, [
            { amount: 100000n, script: makeP2TRScript(1) },
        ]);
        const commitmentTxid = commitmentRaw.txid;
        onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
        onchain.confirmedTxids.add(commitmentTxid);

        // Parent (Tree node)
        const treeTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
            parentScript: makeP2TRScript(1),
            tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
        });

        // Checkpoint Node - FORGED: expires at 3500 while parent expires at 2000 (outlives parent)
        const checkpointTx = createVirtualTx(treeTx.txid, 0, [{ amount: 100000n }], {
            parentScript: makeP2TRScript(2),
            tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[2]),
        });

        indexer.chain = [
            {
                txid: checkpointTx.txid,
                expiresAt: "3500",
                type: ChainTxType.CHECKPOINT,
                spends: [treeTx.txid],
            },
            {
                txid: treeTx.txid,
                expiresAt: "2000",
                type: ChainTxType.TREE,
                spends: [commitmentTxid],
            },
            { txid: commitmentTxid, expiresAt: "3000", type: ChainTxType.COMMITMENT, spends: [] },
        ];

        indexer.virtualTxs.set(treeTx.txid, base64.encode(treeTx.tx.toPSBT()));
        indexer.virtualTxs.set(checkpointTx.txid, base64.encode(checkpointTx.tx.toPSBT()));

        await expect(
            reconstructAndValidateVtxoDAG({ txid: checkpointTx.txid, vout: 0 }, indexer, onchain),
        ).rejects.toThrow(/CHECKPOINT_EXPIRY_INCOHERENT/);
    });

    it("FORGERY: should reject trivial OP_TRUE script injections for policy bypass", async () => {
        const commitmentRaw = createVirtualTx(fakeCommitmentTxid(701), 0, [
            { amount: 100000n, script: makeP2TRScript(1) },
        ]);
        const commitmentTxid = commitmentRaw.txid;
        onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
        onchain.confirmedTxids.add(commitmentTxid);

        // MALICIOUS SCRIPT: just OP_TRUE (0x51).
        const trivialScript = new Uint8Array([0x51]);
        const internalKey = schnorr.getPublicKey(TEST_PRIVKEYS[1]);

        // Use p2tr helper to get a perfectly formatted but conceptually malicious leaf
        const tr = p2tr(internalKey, { script: trivialScript }, undefined, true);

        const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
            parentScript: tr.script,
            tapInternalKey: internalKey,
            tapLeafScript: tr.tapLeafScript,
            tapMerkleRoot: tr.tapMerkleRoot,
        });

        indexer.chain = [
            {
                txid: vtxoTx.txid,
                expiresAt: "2000",
                type: ChainTxType.ARK,
                spends: [commitmentTxid],
            },
            { txid: commitmentTxid, expiresAt: "3000", type: ChainTxType.COMMITMENT, spends: [] },
        ];
        indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

        // Should be blocked by verifyArkExitPolicy (Structural Parsing Hardening)
        await expect(
            reconstructAndValidateVtxoDAG({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain),
        ).rejects.toThrow(/SECURITY_VIOLATION/);
    });

    // ─── Scenario 4: Economic Inflation & Structural Attacks ─────────────────
    it("INFLATION: should reject when a child transaction inflates the output amount (creating money out of thin air)", async () => {
        const commitmentRaw = createVirtualTx(fakeCommitmentTxid(801), 0, [
            { amount: 50000n, script: makeP2TRScript(1) }, // The true on-chain funding is only 50k
        ]);
        const commitmentTxid = commitmentRaw.txid;
        onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
        onchain.confirmedTxids.add(commitmentTxid);

        // Malicious ASP creates a VTXO of 100k out of a 50k parent output
        const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
            parentScript: makeP2TRScript(1),
            tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
        });

        indexer.chain = [
            {
                txid: vtxoTx.txid,
                expiresAt: "2000000000",
                type: ChainTxType.ARK,
                spends: [commitmentTxid],
            },
            {
                txid: commitmentTxid,
                expiresAt: "2000000000",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];
        indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

        await expect(
            reconstructAndValidateVtxoDAG({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain),
        ).rejects.toThrow(/AMOUNT_MISMATCH/);
    });

    it("DOS / CYCLE: should violently reject a malicious DAG that contains an infinite loop to prevent SDK crash", async () => {
        const commitmentRaw = createVirtualTx(fakeCommitmentTxid(998), 0, [
            { amount: 100000n, script: makeP2TRScript(1) },
        ]);
        const commitmentTxid = commitmentRaw.txid;
        onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
        onchain.confirmedTxids.add(commitmentTxid);

        const fakeRoot = "vtxo_infinity_root";
        const fakeChild = "vtxo_infinity_loop";

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
            {
                txid: commitmentTxid,
                expiresAt: "2000000000",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];

        const tx1 = createVirtualTx(fakeChild, 0, [{ amount: 100n }]);
        const tx2 = createVirtualTx(fakeRoot, 0, [{ amount: 100n }]);

        indexer.virtualTxs.set(fakeRoot, base64.encode(tx1.tx.toPSBT()));
        indexer.virtualTxs.set(fakeChild, base64.encode(tx2.tx.toPSBT()));

        await expect(
            reconstructAndValidateVtxoDAG({ txid: fakeRoot, vout: 0 }, indexer, onchain),
        ).rejects.toThrow(/CYCLE_DETECTED|INPUT_CHAIN_BREAK|TXID_MISMATCH/);
    });

    it("ORPHAN / DISTRACTION: should reject a payload containing unreachable corrupted sub-graphs", async () => {
        const commitmentRaw = createVirtualTx(fakeCommitmentTxid(901), 0, [
            { amount: 50000n, script: makeP2TRScript(1) },
        ]);
        const commitmentTxid = commitmentRaw.txid;
        onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
        onchain.confirmedTxids.add(commitmentTxid);

        // Valid branch
        const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 50000n }], {
            parentScript: makeP2TRScript(1),
            tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
        });

        // Orphan/distraction branch that has NO anchor to the commitment tx
        const orphanTx = createVirtualTx("completely_fake_parent_tx", 0, [{ amount: 1000n }]);

        signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[1], [
            { script: makeP2TRScript(1), amount: 50000n },
        ]);

        indexer.chain = [
            {
                txid: vtxoTx.txid,
                expiresAt: "2000000000",
                type: ChainTxType.ARK,
                spends: [commitmentTxid],
            },
            {
                txid: orphanTx.txid,
                expiresAt: "2000000000",
                type: ChainTxType.TREE,
                spends: ["completely_fake_parent_tx"],
            },
            {
                txid: commitmentTxid,
                expiresAt: "2000000000",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];
        indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));
        indexer.virtualTxs.set(orphanTx.txid, base64.encode(orphanTx.tx.toPSBT()));

        await expect(
            reconstructAndValidateVtxoDAG({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain),
        ).rejects.toThrow(/ORPHAN_TX|INPUT_CHAIN_BREAK/);
    });
});
