/**
 * Tier 3: Sovereign Unilateral Exit Data Storage
 * 
 * Secure persistence and orchestration of broadcast sequences,
 * hardened with AES-256-GCM authenticated encryption.
 */

import { hex } from "@scure/base";
import type { DAGNode, Outpoint, StorageProvider, IndexerProvider, OnchainProvider } from "./vtxoDAGVerification.js";
import { reconstructAndValidateVtxoDAG } from "./vtxoDAGVerification.js";
import { StorageCrypto } from "./cryptoUtils.js";
import { MockWalletAuthenticator } from "./authenticator.js";

// The master key is now derived via PBKDF2 in the authenticator and injected 
// into the storage context, rather than being hardcoded.
let activeMasterKey: Buffer | null = null;

/** Sets the global security context with a derived master key. */
export function setStorageMasterKey(key: Buffer) {
  activeMasterKey = key;
}

function getActiveKey(): Buffer {
  if (!activeMasterKey) {
    throw new Error("Security Error: Storage Master Key not initialized. Authenticator required.");
  }
  return activeMasterKey;
}

export interface SovereignExitData {
  /** The specific VTXO root (the user's outpoint) being protected. */
  vtxoRootTxid: string;
  /** The Anchor commitment transaction ID. */
  commitmentTxid: string;
  /** The batch output index on the commitment transaction. */
  batchOutputIndex: number;
  /** Ordered array of hex-encoded transactions to broadcast (Anchor -> ... -> VTXO Root). */
  broadcastSequence: string[];
  /** Timestamp when this data was secured. */
  securedAt: number;
}

// ─── Extraction & Orchestration ─────────────────────────────────────────────

/**
 * Traverses a validated DAG from the Anchoring Leaf to find the specific path
 * descending to the target VTXO Root, returning the ordered hex transactions.
 * Order: [AnchorTx (spends commitment), ..., IntermediateTx, ... , VTXO Root Tx]
 * 
 * This sequence is exactly the order required for on-chain
 * transaction broadcasting to satisfy topological consensus checks.
 *
 * @param anchoringLeaf The leaf of the DAG (directly spending the commitment).
 * @param vtxoRootTxid The ultimate VTXO target txid.
 * @returns Array of hex-encoded, broadcast-ready transactions.
 */
export function extractExitSequence(anchoringLeaf: DAGNode, vtxoRootTxid: string): string[] {
  const sequence: string[] = [];

  function dfs(node: DAGNode, currentPath: string[]): boolean {
    const rawTx = hex.encode(node.tx.toBytes());
    currentPath.push(rawTx);

    if (node.txid === vtxoRootTxid) {
      sequence.push(...currentPath);
      return true;
    }

    for (const child of node.children.values()) {
      if (dfs(child, currentPath)) {
        return true;
      }
    }

    currentPath.pop();
    return false;
  }

  const found = dfs(anchoringLeaf, []);
  if (!found) {
    throw new Error(`Critical: VTXO Root ${vtxoRootTxid} not reachable from Anchoring Leaf ${anchoringLeaf.txid}`);
  }

  return sequence;
}

// ─── Storage Persistence ───────────────────────────────────────────────────

function getStorageKey(vtxoRootTxid: string): string {
  return `arkade_exit_data_${vtxoRootTxid}`;
}

/**
 * Extracts and persists the exit data directly to the SDK local storage.
 * 
 * @param result The successfully validated pipeline result.
 * @param storage The sovereign storage adapter instance.
 */
export async function persistVtxoForExit(
  result: Awaited<ReturnType<typeof reconstructAndValidateVtxoDAG>>,
  storage: StorageProvider
): Promise<void> {
  const broadcastSequence = extractExitSequence(result.anchoringLeaf, result.vtxoRoot.txid);

  const exitData: SovereignExitData = {
    vtxoRootTxid: result.vtxoRoot.txid,
    commitmentTxid: result.commitmentTxid,
    batchOutputIndex: result.batchOutputIndex,
    broadcastSequence,
    securedAt: Date.now(),
  };

  const payload = JSON.stringify(exitData);
  const encrypted = StorageCrypto.encrypt(payload, getActiveKey());
  
  await storage.setItem(getStorageKey(exitData.vtxoRootTxid), encrypted.toString("base64"));
}

/**
 * Recovers the strict top-down broadcast sequence for unilateral exit execution.
 * Fails loudly if the data was not autonomously secured prior to network drop.
 * 
 * @param vtxoRootTxid 
 * @param storage 
 */
export async function getBroadcastSequence(
  vtxoRootTxid: string,
  storage: StorageProvider
): Promise<string[]> {
  const encryptedB64 = await storage.getItem(getStorageKey(vtxoRootTxid));
  if (!encryptedB64) {
    throw new Error(`Sovereign Exit Failed: No local data secured for VTXO Root ${vtxoRootTxid}. ASP connection required!`);
  }

  const encrypted = Buffer.from(encryptedB64, "base64");
  const decrypted = StorageCrypto.decrypt(encrypted, getActiveKey());
  
  const data: SovereignExitData = JSON.parse(decrypted);
  return data.broadcastSequence;
}

// ─── Automated Webhook Integrations ─────────────────────────────────────────

/**
 * Automates the pipeline. Triggers the full Tier 2 Tier 1 verification structure,
 * and if authentic, isolates the metadata and saves it for a future sovereign exit.
 * 
 * To be called natively whenever a new VTXO is detected or swapped.
 */
export async function onReceiveVtxo(
  outpoint: Outpoint,
  indexer: IndexerProvider,
  onchain: OnchainProvider,
  storage: StorageProvider
): Promise<{ success: boolean; diagnostics: string[]; error?: string }> {
  try {
    // 1. Run rigorous multi-layered verification (DAG, Sigs, Taproot, Timelocks, HTLCs)
    const verificationResult = await reconstructAndValidateVtxoDAG(outpoint, indexer, onchain);

    // 2. Persist Sovereign Exit Data locally, cutting ASP ties for exiting
    await persistVtxoForExit(verificationResult, storage);

    return {
      success: true,
      diagnostics: [
        ...verificationResult.diagnostics,
        ` Local sovereign exit data secured for ${outpoint.txid}`
      ]
    };

  } catch (error: any) {
    return {
      success: false,
      diagnostics: ["Verification Pipeline Terminated"],
      error: error.message
    };
  }
}

/**
 * Consumes natively stored data (requiring NO ASP connection) and attempts to 
 * push the exact pre-computed topological sequence to the Bitcoin network. 
 * This effectively executes the Unilateral Sovereign Exit.
 */
export async function executeSovereignExit(
  vtxoRootTxid: string,
  storage: StorageProvider,
  onchain: OnchainProvider
): Promise<{ success: boolean; broadcastedTxids: string[]; error?: string }> {
  const broadcastedTxids: string[] = [];

  try {
    const broadcastSequence = await getBroadcastSequence(vtxoRootTxid, storage);

    // Sequence is correctly ordered top-down relative to the DAG structure
    for (const txHex of broadcastSequence) {
      const txid = await onchain.broadcastTransaction(txHex);
      broadcastedTxids.push(txid);
    }

    return { success: true, broadcastedTxids };
  } catch (error: any) {
    return { success: false, broadcastedTxids, error: error.message };
  }
}
