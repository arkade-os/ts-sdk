/**
 * ============================================================================
 *  Unit Tests — VTXO DAG Verification (Tier 1 & Tier 2)
 * ============================================================================
 *
 *  Tests the DAG reconstruction and validation logic using mock data
 *  that simulates the structures returned by the Arkade IndexerService.
 * ============================================================================
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { hex, base64 } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { taprootTweakPubkey, taprootTweakPrivKey } from "@scure/btc-signer/utils.js";
import { p2tr } from "@scure/btc-signer/payment.js";
import { Script, OP } from "@scure/btc-signer/script.js";
import {
  reconstructAndValidateVtxoDAG,
  ChainTxType,
  type Outpoint,
  type ChainTx,
  type IndexerProvider,
  type OnchainProvider,
} from "../vtxoDAGVerification.js";
import {
  extractTimelockConstraints,
  validateTimelockConsistency,
  validateTimelockSatisfiability,
  type ChainState,
} from "../timelockVerification.js";
import {
  extractHashConditions,
  verifyPreimage,
  verifyNodeHashPreimages,
} from "../hashPreimageVerification.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

export const TEST_PRIVKEYS = Array.from({ length: 10 }, (_, i) => {
  const key = new Uint8Array(32);
  key[31] = i + 1;
  return key;
});

export function makeP2TRScript(seed: number = 0, merkleRoot?: Uint8Array): Uint8Array {
  const privKey = TEST_PRIVKEYS[seed % TEST_PRIVKEYS.length];
  const internalKey = schnorr.getPublicKey(privKey);
  const [tweakedKey] = taprootTweakPubkey(internalKey, merkleRoot || new Uint8Array(0));
  const script = new Uint8Array(34);
  script[0] = 0x51; 
  script[1] = 0x20;
  script.set(tweakedKey, 2);
  return script;
}

export function fakeCommitmentTxid(seed: number = 0): string {
  return (seed.toString(16) + "a").repeat(64).slice(0, 64);
}

export function createVirtualTx(
  parentTxid: string,
  parentVout: number,
  outputs: { amount: bigint; script?: Uint8Array }[],
  opts?: {
    sequence?: number;
    lockTime?: number;
    tapInternalKey?: Uint8Array;
    parentScript?: Uint8Array;
    tapLeafScript?: any;
    tapMerkleRoot?: Uint8Array;
  }
): { tx: Transaction; psbtB64: string; txid: string } {
  const hexTxid = parentTxid.length === 64 ? parentTxid : fakeCommitmentTxid(1);
  const p2trScript = opts?.parentScript ?? makeP2TRScript(0);
  const tx = new Transaction({
    version: 2,
    allowUnknownOutputs: true,
    lockTime: opts?.lockTime ?? 0,
  });

  tx.addInput({
    txid: hexTxid,
    index: parentVout,
    sequence: opts?.sequence ?? 0xffffffff,
    witnessUtxo: {
      amount: outputs.reduce((sum, o) => sum + o.amount, 0n),
      script: p2trScript,
    },
    tapInternalKey: opts?.tapInternalKey ?? schnorr.getPublicKey(TEST_PRIVKEYS[0]),
  });

  if (opts?.tapLeafScript) {
    tx.updateInput(0, { tapLeafScript: opts.tapLeafScript });
  }
  if (opts?.tapMerkleRoot) {
    tx.updateInput(0, { tapMerkleRoot: opts.tapMerkleRoot });
  }

  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i];
    tx.addOutput({
      amount: out.amount,
      script: out.script ?? makeP2TRScript(i + 1),
    });
  }

  return { tx, psbtB64: base64.encode(tx.toPSBT()), txid: tx.id };
}

export function signVirtualTx(tx: Transaction, inputIndex: number, privKey: Uint8Array, prevOuts: { script: Uint8Array, amount: bigint }[]) {
  const scripts = prevOuts.map(o => o.script);
  const amounts = prevOuts.map(o => o.amount);
  const sighash = (tx as any).preimageWitnessV1(inputIndex, scripts, 0, amounts);
  
  const input = tx.getInput(inputIndex);
  const merkleRoot = input.tapMerkleRoot || new Uint8Array(0);
  const tweakedPrivKey = taprootTweakPrivKey(privKey, merkleRoot);
  
  const sig = schnorr.sign(sighash, tweakedPrivKey);
  tx.updateInput(inputIndex, { tapKeySig: sig });
}

// ─── Mock Providers ──────────────────────────────────────────────────────────

export class MockIndexerProvider implements IndexerProvider {
  public chain: ChainTx[] = [];
  public virtualTxs: Map<string, string> = new Map();

  async getBatchVtxos(_commitmentTxid: string) {
    // In the mock, we assume the provided chain belongs to the requested batch
    return [{ chain: this.chain }];
  }

  async getVirtualTxs(txids: string[]) {
    const txs: string[] = [];
    for (const txid of txids) {
      const psbt = this.virtualTxs.get(txid);
      if (psbt) txs.push(psbt);
    }
    return { txs };
  }
}

export class MockOnchainProvider implements OnchainProvider {
  public confirmedTxids = new Set<string>();
  public txs = new Map<string, string>();
  public chainHeight = 100;
  public chainMedianTime = 1700000000;

  async getRawTransaction(txid: string) {
    return this.txs.get(txid) || "";
  }

  async getTxStatus(txid: string) {
    if (this.confirmedTxids.has(txid)) {
      return { confirmed: true, blockHeight: this.chainHeight, blockTime: this.chainMedianTime };
    }
    return { confirmed: false };
  }

  async getBlockchainInfo() {
    return { height: this.chainHeight, medianTime: this.chainMedianTime };
  }

  public broadcastedTxs: string[] = [];
  async broadcastTransaction(txHex: string): Promise<string> {
    this.broadcastedTxs.push(txHex);
    // Simple mock txid hash return
    return `broadcasted_${txHex.substring(0, 10)}`;
  }
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe("VTXO DAG Verification", () => {
  let indexer: MockIndexerProvider;
  let onchain: MockOnchainProvider;

  beforeEach(() => {
    indexer = new MockIndexerProvider();
    onchain = new MockOnchainProvider();
  });

  describe("Tier 1 Tasks", () => {
    it("should reconstruct and validate a simple signed DAG", async () => {
      const commitmentTxid = fakeCommitmentTxid(2);
      const commitmentRaw = createVirtualTx(fakeCommitmentTxid(3), 0, [
        { amount: 100000n, script: makeP2TRScript(1) }
      ]);
      onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
      onchain.confirmedTxids.add(commitmentTxid);

      const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
        parentScript: makeP2TRScript(1),
        tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1])
      });
      
      signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[1], [{ script: makeP2TRScript(1), amount: 100000n }]);

      indexer.chain = [
        { txid: vtxoTx.txid, expiresAt: "2000000000", type: ChainTxType.ARK, spends: [commitmentTxid] },
        { txid: commitmentTxid, expiresAt: "2000000000", type: ChainTxType.COMMITMENT, spends: [] }
      ];
      indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

      const result = await reconstructAndValidateVtxoDAG(
        { txid: vtxoTx.txid, vout: 0 },
        indexer,
        onchain
      );
      expect(result.valid).toBe(true);
    });

    it("should fail with INVALID_SIGNATURE on tamper", async () => {
      const commitmentTxid = fakeCommitmentTxid(6);
      const commitmentRaw = createVirtualTx(fakeCommitmentTxid(7), 0, [{ amount: 100000n }]);
      onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
      onchain.confirmedTxids.add(commitmentTxid);

      const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }]);
      signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [{ script: makeP2TRScript(0), amount: 100000n }]);
      
      const input = vtxoTx.tx.getInput(0);
      input.tapKeySig![0] ^= 0x01; 

      indexer.chain = [
        { txid: vtxoTx.txid, expiresAt: "2000000000", type: ChainTxType.ARK, spends: [commitmentTxid] },
        { txid: commitmentTxid, expiresAt: "2000000000", type: ChainTxType.COMMITMENT, spends: [] }
      ];
      indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

      // Verify that it fails due to the root anchor mismatch or signature tamper.
      // Note: In Step 8 order, Taproot Tweak is verified before Signatures.
      await expect(reconstructAndValidateVtxoDAG({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain))
        .rejects.toThrow(/INVALID_TAPROOT_TWEAK|INVALID_SIGNATURE/);
    });
  });

  describe("Tier 2 Phase 1: Taproot Script & Tree Verification", () => {
    it("should verify a node with a valid Taproot script tree", async () => {
      const internalKey = schnorr.getPublicKey(TEST_PRIVKEYS[0]);
      const userKey = schnorr.getPublicKey(TEST_PRIVKEYS[1]);
      const validArkScript = hex.decode(`0190b27520${hex.encode(userKey)}ac`);

      const tr = p2tr(internalKey, { script: validArkScript }, undefined, true);
      const commitmentTxid = fakeCommitmentTxid(10);
      onchain.txs.set(commitmentTxid, hex.encode(createVirtualTx(fakeCommitmentTxid(11), 0, [{ amount: 100000n, script: tr.script }]).tx.toBytes()));
      onchain.confirmedTxids.add(commitmentTxid);

      const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
        parentScript: tr.script,
        tapInternalKey: internalKey,
        sequence: 0x190, // 400-block relative delay (matches the script's CSV push of 0x0190)
      });
      
      vtxoTx.tx.updateInput(0, {
        tapMerkleRoot: tr.tapMerkleRoot,
        tapLeafScript: tr.tapLeafScript
      });
      
      signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [{ script: tr.script, amount: 100000n }]);

      indexer.chain = [
        { txid: vtxoTx.txid, expiresAt: "2000000000", type: ChainTxType.ARK, spends: [commitmentTxid] },
        { txid: commitmentTxid, expiresAt: "2000000000", type: ChainTxType.COMMITMENT, spends: [] }
      ];
      indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

      const result = await reconstructAndValidateVtxoDAG(
        { txid: vtxoTx.txid, vout: 0 },
        indexer,
        onchain
      );
      expect(result.valid).toBe(true);
    });

    it("should fail if the leaf script violates Ark exit policy", async () => {
      const internalKey = schnorr.getPublicKey(TEST_PRIVKEYS[0]);
      const badExitScript = hex.decode("0000");

      const tr = p2tr(internalKey, { script: badExitScript }, undefined, true);
      const commitmentTxid = fakeCommitmentTxid(14);
      onchain.txs.set(commitmentTxid, hex.encode(createVirtualTx(fakeCommitmentTxid(15), 0, [{ amount: 100000n, script: tr.script }]).tx.toBytes()));
      onchain.confirmedTxids.add(commitmentTxid);
      
      const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
        parentScript: tr.script,
        tapInternalKey: internalKey
      });
      
      vtxoTx.tx.updateInput(0, {
        tapMerkleRoot: tr.tapMerkleRoot,
        tapLeafScript: tr.tapLeafScript
      });
      
      signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [{ script: tr.script, amount: 100000n }]);

      indexer.chain = [
        { txid: vtxoTx.txid, expiresAt: "2000000000", type: ChainTxType.ARK, spends: [commitmentTxid] },
        { txid: commitmentTxid, expiresAt: "2000000000", type: ChainTxType.COMMITMENT, spends: [] }
      ];
      indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

      await expect(reconstructAndValidateVtxoDAG({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain))
        .rejects.toThrow("INVALID_ARK_SCRIPT");
    });
  });

  describe("Tier 2 Phase 2: Timelock Verification", () => {
    it("should pass with a valid CSV timelock (nSequence=10, script OP_10 OP_CSV)", async () => {
      const internalKey = schnorr.getPublicKey(TEST_PRIVKEYS[0]);
      const userKey = schnorr.getPublicKey(TEST_PRIVKEYS[1]);
      // Script: <10> OP_CSV OP_DROP <userKey> OP_CHECKSIG
      // This is a standard Ark exit: relative timelock of 10 blocks + key check
      const csvScript = Script.encode([
        10,                       // OP_10 (push small int)
        "CHECKSEQUENCEVERIFY",    // OP_CSV (0xb2)
        "DROP",
        userKey,
        "CHECKSIG",
      ]);

      const tr = p2tr(internalKey, { script: csvScript }, undefined, true);
      const commitmentTxid = fakeCommitmentTxid(20);
      onchain.txs.set(commitmentTxid, hex.encode(
        createVirtualTx(fakeCommitmentTxid(21), 0, [{ amount: 100000n, script: tr.script }]).tx.toBytes()
      ));
      onchain.confirmedTxids.add(commitmentTxid);

      const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
        parentScript: tr.script,
        tapInternalKey: internalKey,
        sequence: 10, // nSequence = 10 blocks relative timelock
      });

      vtxoTx.tx.updateInput(0, {
        tapMerkleRoot: tr.tapMerkleRoot,
        tapLeafScript: tr.tapLeafScript,
      });

      signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [{ script: tr.script, amount: 100000n }]);

      indexer.chain = [
        { txid: vtxoTx.txid, expiresAt: "2000000000", type: ChainTxType.ARK, spends: [commitmentTxid] },
        { txid: commitmentTxid, expiresAt: "2000000000", type: ChainTxType.COMMITMENT, spends: [] }
      ];
      indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

      const result = await reconstructAndValidateVtxoDAG(
        { txid: vtxoTx.txid, vout: 0 },
        indexer,
        onchain
      );
      expect(result.valid).toBe(true);
    });

    it("should fail when CSV is used but nSequence disables relative timelock", () => {
      // Unit test directly on the consistency validator
      const constraints = {
        nLockTime: 0,
        nSequence: 0xffffffff, // FINAL — disables relative timelock
        csvValues: [10],
        cltvValues: [],
        lockTimeType: "none" as const,
        sequenceType: "final" as const,
        isKeyPathSpend: false,
      };

      expect(() => validateTimelockConsistency(constraints, "deadbeef"))
        .toThrow("TIMELOCK_INCONSISTENT");
    });

    it("should fail on CLTV/nLockTime domain mismatch (blocks vs time)", () => {
      // nLockTime uses block height, but CLTV uses timestamp
      const constraints = {
        nLockTime: 800000,        // block-based
        nSequence: 0xffffffff,
        csvValues: [],
        cltvValues: [1700000000], // time-based (UNIX timestamp)
        lockTimeType: "blocks" as const,
        sequenceType: "final" as const,
        isKeyPathSpend: false,
      };

      expect(() => validateTimelockConsistency(constraints, "deadbeef"))
        .toThrow("TIMELOCK_INCONSISTENT");
    });

    it("should fail when CLTV block height is not yet satisfiable", () => {
      const constraints = {
        nLockTime: 999999,
        nSequence: 0xffffffff,
        csvValues: [],
        cltvValues: [999999],
        lockTimeType: "blocks" as const,
        sequenceType: "final" as const,
        isKeyPathSpend: false,
      };

      const chainState: ChainState = {
        currentHeight: 100,
        currentTime: 1700000000,
      };

      // Consistency passes (CLTV and nLockTime are both block-based)
      validateTimelockConsistency(constraints, "deadbeef");

      // Satisfiability fails (chain at height 100, need 999999)
      expect(() => validateTimelockSatisfiability(constraints, chainState, "deadbeef"))
        .toThrow("TIMELOCK_UNSATISFIABLE");
    });

    it("should pass with valid CLTV + CSV combined constraints", () => {
      const constraints = {
        nLockTime: 800000,        // absolute lock: block 800000
        nSequence: 10,            // relative lock: 10 blocks
        csvValues: [10],
        cltvValues: [800000],
        lockTimeType: "blocks" as const,
        sequenceType: "blocks" as const,
        isKeyPathSpend: false,
      };

      const chainState: ChainState = {
        currentHeight: 800100,    // well past block 800000
        currentTime: 1700000000,
      };

      // Both checks should pass
      validateTimelockConsistency(constraints, "deadbeef");
      validateTimelockSatisfiability(constraints, chainState, "deadbeef");
    });
  });

  describe("Tier 2 Phase 3: Hash Preimage & Boltz Submarine Swap Verification", () => {
    it("should extract and verify a HASH160 preimage (Boltz claim pattern)", () => {
      // Direct unit test on the hash preimage module

      // Generate a random preimage (32 bytes — Boltz standard)
      const preimage = new Uint8Array(32);
      for (let i = 0; i < 32; i++) preimage[i] = (i * 7 + 13) % 256;

      // Boltz HASH160 = RIPEMD160(SHA256(preimage))
      const preimageHash = ripemd160(sha256(preimage));

      // Construct a Boltz-style claim script:
      //   OP_HASH160 <hash160(preimage)> OP_EQUALVERIFY <claimPubkey> OP_CHECKSIG
      const claimKey = schnorr.getPublicKey(TEST_PRIVKEYS[1]);
      const claimScript = Script.encode([
        "HASH160",
        preimageHash,
        "EQUALVERIFY",
        claimKey,
        "CHECKSIG",
      ]);

      // Decode and extract conditions
      const decoded = Script.decode(claimScript);
      const conditions = extractHashConditions(decoded);

      expect(conditions).toHaveLength(1);
      expect(conditions[0].opcode).toBe("HASH160");
      expect(hex.encode(conditions[0].expectedHash)).toBe(hex.encode(preimageHash));

      // Verify with correct preimage
      const result = verifyPreimage(preimage, conditions[0]);
      expect(result.valid).toBe(true);
      expect(result.computedHash).toBe(result.expectedHash);
    });

    it("should reject an incorrect preimage for HASH160", () => {
      const realPreimage = new Uint8Array(32).fill(0xaa);
      const fakePreimage = new Uint8Array(32).fill(0xbb);
      const expectedHash = ripemd160(sha256(realPreimage));

      const claimKey = schnorr.getPublicKey(TEST_PRIVKEYS[2]);
      const claimScript = Script.encode([
        "HASH160", expectedHash, "EQUALVERIFY", claimKey, "CHECKSIG",
      ]);

      const decoded = Script.decode(claimScript);
      const conditions = extractHashConditions(decoded);
      expect(conditions).toHaveLength(1);

      // Wrong preimage should fail
      const result = verifyPreimage(fakePreimage, conditions[0]);
      expect(result.valid).toBe(false);
      expect(result.computedHash).not.toBe(result.expectedHash);
    });

    it("should verify a SHA256 hash-lock condition", () => {
      const preimage = new Uint8Array(32).fill(0x42);
      const expectedHash = sha256(preimage);

      // SHA256 hash-lock script: OP_SHA256 <hash> OP_EQUALVERIFY <key> OP_CHECKSIG
      const key = schnorr.getPublicKey(TEST_PRIVKEYS[3]);
      const script = Script.encode([
        "SHA256", expectedHash, "EQUALVERIFY", key, "CHECKSIG",
      ]);

      const decoded = Script.decode(script);
      const conditions = extractHashConditions(decoded);
      expect(conditions).toHaveLength(1);
      expect(conditions[0].opcode).toBe("SHA256");

      const result = verifyPreimage(preimage, conditions[0]);
      expect(result.valid).toBe(true);
    });

    it("should verify a full Boltz submarine swap (Ark → Lightning) HTLC", async () => {
      /**
       * Boltz Submarine Swap Scenario:
       * ═══════════════════════════════
       * Alice wants to pay Bob on Lightning via a Boltz submarine swap.
       *
       * 1. Boltz generates an invoice with payment_hash = SHA256(preimage)
       * 2. Alice locks funds in a Taproot HTLC on the Ark virtual tree
       * 3. The HTLC has TWO tapscript leaves:
       *    - Claim leaf: OP_HASH160 <ripemd160(sha256(preimage))> OP_EQUALVERIFY <boltzKey> OP_CHECKSIG
       *    - Refund leaf: <aliceKey> OP_CHECKSIGVERIFY <timeout> OP_CHECKLOCKTIMEVERIFY
       * 4. When the Lightning payment succeeds, Boltz reveals the preimage
       * 5. Boltz claims the on-chain HTLC using the claim leaf
       *
       * This test verifies the ENTIRE pipeline works end-to-end.
       */

      // ── Swap participants ──────────────────────────────────────────
      const boltzPrivKey = TEST_PRIVKEYS[3];
      const boltzPubKey = schnorr.getPublicKey(boltzPrivKey);
      const alicePrivKey = TEST_PRIVKEYS[4];
      const alicePubKey = schnorr.getPublicKey(alicePrivKey);

      // ── Generate the swap preimage (Lightning payment secret) ──────
      const swapPreimage = new Uint8Array(32);
      for (let i = 0; i < 32; i++) swapPreimage[i] = (i * 11 + 5) % 256;

      const preimageHashSha256 = sha256(swapPreimage);
      const preimageHashRipemd = ripemd160(preimageHashSha256);

      // ── Construct the Boltz HTLC tree (exact Boltz protocol) ───────
      // Claim leaf (Boltz claims with preimage):
      //   OP_HASH160 <RIPEMD160(SHA256(preimage))> OP_EQUALVERIFY <boltzKey> OP_CHECKSIG
      const claimScript = Script.encode([
        "HASH160",
        preimageHashRipemd,
        "EQUALVERIFY",
        boltzPubKey,
        "CHECKSIG",
      ]);

      // Refund leaf (Alice refunds after timeout):
      //   <aliceKey> OP_CHECKSIGVERIFY <timeout> OP_CHECKLOCKTIMEVERIFY
      const TIMEOUT_BLOCK = 800100;
      const refundScript = Script.encode([
        alicePubKey,
        "CHECKSIGVERIFY",
        TIMEOUT_BLOCK,
        "CHECKLOCKTIMEVERIFY",
      ]);

      // ── Build the Taproot tree with both leaves ────────────────────
      // Internal key = co-signing key (Boltz MuSig2 aggregate, simulated)
      const internalKey = schnorr.getPublicKey(TEST_PRIVKEYS[5]);

      const tr = p2tr(
        internalKey,
        [
          { script: claimScript },  // Claim leaf
          { script: refundScript }, // Refund leaf
        ],
        undefined,
        true // allowUnknownOutputs
      );

      // ── Set up the on-chain commitment ─────────────────────────────
      const commitmentTxid = fakeCommitmentTxid(30);
      const commitmentOut = createVirtualTx(
        fakeCommitmentTxid(31), 0,
        [{ amount: 50000n, script: tr.script }]
      );
      onchain.txs.set(commitmentTxid, hex.encode(commitmentOut.tx.toBytes()));
      onchain.confirmedTxids.add(commitmentTxid);
      onchain.chainHeight = 800200; // Past the refund timeout

      // ── Create the VTXO that locks funds in the HTLC ──────────────
      const htlcVtxo = createVirtualTx(commitmentTxid, 0, [{ amount: 50000n }], {
        parentScript: tr.script,
        tapInternalKey: internalKey,
        sequence: 0xffffffff, // No relative timelock on the main input
      });

      // Attach the full Taproot tree metadata
      htlcVtxo.tx.updateInput(0, {
        tapMerkleRoot: tr.tapMerkleRoot,
        tapLeafScript: tr.tapLeafScript,
      });

      // Sign with the internal key (key-path signature)
      signVirtualTx(htlcVtxo.tx, 0, TEST_PRIVKEYS[5], [
        { script: tr.script, amount: 50000n },
      ]);

      // ── Register in the indexer ────────────────────────────────────
      indexer.chain = [
        { txid: htlcVtxo.txid, expiresAt: "2000000000", type: ChainTxType.ARK, spends: [commitmentTxid] },
        { txid: commitmentTxid, expiresAt: "2000000000", type: ChainTxType.COMMITMENT, spends: [] },
      ];
      indexer.virtualTxs.set(htlcVtxo.txid, base64.encode(htlcVtxo.tx.toPSBT()));

      // Build the preimage supply map: hash → preimage
      const preimages = new Map<string, Uint8Array>();
      preimages.set(hex.encode(preimageHashRipemd), swapPreimage);

      // ── Run the FULL verification pipeline ─────────────────────────
      // We MUST pass preimages now as they are mandatory for security
      const result = await reconstructAndValidateVtxoDAG(
        { txid: htlcVtxo.txid, vout: 0 },
        indexer,
        onchain,
        preimages
      );

      // Pipeline must pass (structural + sig + taproot + timelock + hash)
      expect(result.valid).toBe(true);

      // ── Verify the HTLC preimage explicitly ────────────────────────
      // Now verify that the correct preimage satisfies the claim leaf

      // Build the preimage supply map: hash → preimage
      const witnessPreimages = new Map<string, Uint8Array>();
      witnessPreimages.set(hex.encode(preimageHashRipemd), swapPreimage);

      // The node from the pipeline result should verify cleanly
      expect(() => {
        verifyNodeHashPreimages(result.anchoringLeaf, witnessPreimages);
      }).not.toThrow();

      // ── Verify that a WRONG preimage is rejected ───────────────────
      const badPreimages = new Map<string, Uint8Array>();
      badPreimages.set(hex.encode(preimageHashRipemd), new Uint8Array(32).fill(0xff));

      expect(() => {
        verifyNodeHashPreimages(result.anchoringLeaf, badPreimages);
      }).toThrow("INVALID_HASH_PREIMAGE");
    });
  });
});
