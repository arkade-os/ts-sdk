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
  MockOnchainProvider
} from "./vtxoDAGVerification.test.js";
import { StorageProvider, ChainTxType } from "../vtxoDAGVerification.js";
import {
  onReceiveVtxo,
  getBroadcastSequence,
  persistVtxoForExit,
  extractExitSequence,
  executeSovereignExit
} from "../sovereignStorage.js";

class MockStorageProvider implements StorageProvider {
  private store: Map<string, string> = new Map();

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) || null;
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }
}

import { setStorageMasterKey } from "../sovereignStorage.js";
import { MockWalletAuthenticator } from "../authenticator.js";

describe("Tier 3: Sovereign Unilateral Exit Storage", () => {
  let indexer: MockIndexerProvider;
  let onchain: MockOnchainProvider;
  let storage: MockStorageProvider;

  beforeEach(async () => {
    indexer = new MockIndexerProvider();
    onchain = new MockOnchainProvider();
    storage = new MockStorageProvider();
    
    // 🛡️ Security Protocol: Derive master key via PBKDF2 and inject into context
    const salt = Buffer.alloc(32, 0x55); // Stable salt for testing
    const masterKey = MockWalletAuthenticator.deriveMasterKey("test-password-123", salt);
    setStorageMasterKey(masterKey);
  });

  it("should successfully extract and store an exit sequence from a valid DAG", async () => {
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

    const outpoint = { txid: vtxoTx.txid, vout: 0 };
    
    const result = await onReceiveVtxo(outpoint, indexer, onchain, storage);
    if (!result.success) console.error("Test 1 error:", result.error);
    expect(result.success).toBe(true);
    expect(result.diagnostics).toContain(` Local sovereign exit data secured for ${vtxoTx.txid}`);

    const broadcastSequence = await getBroadcastSequence(vtxoTx.txid, storage);

    // With a 1-node DAG, the extracted path has exactly 1 tx
    expect(broadcastSequence).toHaveLength(1);
    expect(broadcastSequence[0]).toBe(hex.encode(vtxoTx.tx.toBytes()));
  });

  it("should fail gracefully and bubble up errors if DAG validation fails", async () => {
    // Missing from onchain, creating validation fail
    const commitmentTxid = fakeCommitmentTxid(20);
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

    const result = await onReceiveVtxo({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain, storage);
    
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    
    const stored = await storage.getItem(`arkade_exit_data_${vtxoTx.txid}`);
    expect(stored).toBeNull();
  });

  it("should independently execute a sovereign exit natively using the local Bitcoin node", async () => {
    // Rely on setup from Test 1 that saves data automatically
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

    // Stage 1: The user initially receives the Vtxo while online, natively storing it.
    await onReceiveVtxo({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain, storage);

    // Stage 2: Simulating ASP crash entirely. No indexer queries made here.
    const result = await executeSovereignExit(vtxoTx.txid, storage, onchain);
    
    expect(result.success).toBe(true);
    expect(result.broadcastedTxids).toHaveLength(1);

    // Verify OnchainProvider natively received the transaction payload
    expect(onchain.broadcastedTxs).toHaveLength(1);
    expect(onchain.broadcastedTxs[0]).toBe(hex.encode(vtxoTx.tx.toBytes()));
  });

  it("should ensure data is encrypted in repose (Forensics Protection)", async () => {
    // 1. Setup a valid recibo
    const commitmentTxid = fakeCommitmentTxid(500);
    const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
      parentScript: makeP2TRScript(1),
      tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1])
    });
    onchain.confirmedTxids.add(commitmentTxid);
    onchain.txs.set(commitmentTxid, hex.encode(createVirtualTx("00", 0, [{ amount: 100000n, script: makeP2TRScript(1) }]).tx.toBytes()));

    indexer.chain = [
      { txid: vtxoTx.txid, expiresAt: "2000000000", type: ChainTxType.ARK, spends: [commitmentTxid] },
      { txid: commitmentTxid, expiresAt: "2000000000", type: ChainTxType.COMMITMENT, spends: [] }
    ];
    
    // Sign the transaction so it passes verification
    signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[1], [{ script: makeP2TRScript(1), amount: 100000n }]);
    indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

    // 2. Persist natively
    const result = await onReceiveVtxo({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain, storage);
    expect(result.success, `onReceiveVtxo failed: ${result.error}`).toBe(true);

    // 3. Inspect raw storage (Caja Gris)
    const rawSaved = await storage.getItem(`arkade_exit_data_${vtxoTx.txid}`);
    
    // The data must NOT be readable JSON, it must be a Base64-encoded binary (encrypted)
    expect(rawSaved).not.toBeNull();
    expect(() => JSON.parse(rawSaved!)).toThrow(); // Should fail parsing because it's encrypted
  });
});
