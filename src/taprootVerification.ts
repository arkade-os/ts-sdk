/**
 * ============================================================================
 *  Arkade VTXO Taproot Verification (Tier 2 Phase 1)
 * ============================================================================
 *
 *  Provides cryptographic validation of Taproot structures, Merkle roots,
 *  and Ark-specific exit script policies.
 * ============================================================================
 */

import { hex } from "@scure/base";
import { taprootTweakPubkey, tagSchnorr, compareBytes } from "@scure/btc-signer/utils.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { VtxoVerificationError, type DAGNode } from "./vtxoDAGVerification.js";

/**
 * BIP 341 TapBranch hash: H_TapBranch(min(a,b) || max(a,b))
 * Lexicographic sorting ensures deterministic tree construction.
 * Not exported by @scure/btc-signer, so we implement it here.
 */
function tapBranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  let [left, right] = [a, b];
  if (compareBytes(b, a) === -1) [left, right] = [b, a];
  return tagSchnorr("TapBranch", left, right);
}

/** Byte equality helper */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Verifies the Taproot configuration for a DAG node.
 * Validates the tweak consistency between internal key and witness script.
 */
export function verifyNodeTaproot(node: DAGNode): void {
  const input = node.tx.getInput(0);
  const witnessUtxo = input.witnessUtxo;
  const internalKey = input.tapInternalKey;
  const merkleRoot = input.tapMerkleRoot;

  if (!internalKey) {
    throw new VtxoVerificationError(
      `Transaction ${node.tx.id} is missing tapInternalKey (BIP 341 violation)`,
      "MISSING_TAPROOT_METADATA"
    );
  }

  // 1. Verify Tweaked Pubkey Consistency
  if (witnessUtxo && witnessUtxo.script) {
    const rootBytes = merkleRoot || new Uint8Array(0);
    const [tweakedKey] = taprootTweakPubkey(internalKey, rootBytes);
    const expectedScript = new Uint8Array([0x51, 0x20, ...tweakedKey]);
    
    if (!equalBytes(witnessUtxo.script, expectedScript)) {
      throw new VtxoVerificationError(
        `Invalid Taproot Tweak for transaction ${node.tx.id}`,
        "INVALID_TAPROOT_TWEAK"
      );
    }
  }

  // 2. Validate Merkle Proofs and Exit Policies
  if (merkleRoot && input.tapLeafScript) {
    for (const leaf of input.tapLeafScript) {
      // leaf is [controlBlock, scriptWithVersion] based on PSBT spec and btc-signer
      const [cb, scriptWithVersion] = leaf;
      
      if (!cb || !scriptWithVersion || scriptWithVersion.length < 1) continue;

      // PSBT v0/v2 spec: tapLeafScript value is <script> <leaf_version>
      const script = scriptWithVersion.slice(0, -1);
      const leafVersion = scriptWithVersion[scriptWithVersion.length - 1];

      // 2a. Verify Merkle Proof
      verifyMerkleProof(merkleRoot, script, cb, node.tx.id, leafVersion);
      
      // 2b. Enforce Ark Exit Policy
      verifyArkExitPolicy(script, node.tx.id);
    }
  }
}

function verifyMerkleProof(
  merkleRoot: Uint8Array,
  script: Uint8Array,
  cb: any,
  txid: string,
  providedVersion: number
): void {
  // btc-signer might pass cb as a decoded object or raw bytes
  // If it's the decoded object from psbt.js, we need to re-encode or access properties
  let controlBlock: Uint8Array;
  if (cb instanceof Uint8Array) {
    controlBlock = cb;
  } else if (cb.internalKey && cb.merklePath) {
    // It's a decoded control block object
    // We can manually reconstruct the parts or use the properties
    const leafVersion = providedVersion & 0xfe;
    const leafHash = tapLeafHash(script, leafVersion);
    
    let currentHash = leafHash;
    for (const branch of cb.merklePath) {
      currentHash = tapBranchHash(currentHash, branch);
    }

    if (!equalBytes(currentHash, merkleRoot)) {
       throw new VtxoVerificationError(
         `Merkle proof failure in transaction ${txid}`,
         "INVALID_MERKLE_PROOF"
       );
    }
    return;
  } else {
    throw new VtxoVerificationError(`Invalid control block format in ${txid}`, "INVALID_MERKLE_PROOF");
  }

  // Raw bytes path (fallback)
  if (controlBlock.length < 33) {
      throw new VtxoVerificationError(`Invalid control block length in ${txid}`, "INVALID_MERKLE_PROOF");
  }

  const leafVersion = controlBlock[0] & 0xfe;
  const leafHash = tapLeafHash(script, leafVersion);
  
  let currentHash = leafHash;
  const numSteps = (controlBlock.length - 33) / 32;
  
  for (let i = 0; i < numSteps; i++) {
    const branch = controlBlock.slice(33 + i * 32, 33 + (i + 1) * 32);
    currentHash = tapBranchHash(currentHash, branch);
  }

  if (!equalBytes(currentHash, merkleRoot)) {
    throw new VtxoVerificationError(
       `Merkle proof failure in transaction ${txid}`,
       "INVALID_MERKLE_PROOF"
    );
  }
}

import { Script } from "@scure/btc-signer/script.js";

function verifyArkExitPolicy(script: Uint8Array, txid: string): void {
  let decoded: (string | number | Uint8Array)[];
  try {
    decoded = Script.decode(script);
  } catch (e) {
    throw new VtxoVerificationError(
      `Failed to decode tapleaf script in ${txid}`,
      "INVALID_ARK_SCRIPT"
    );
  }

  // 1. Structural Liveness - Ensure there are no top-level logic bypasses
  // such as a simple OP_TRUE that makes the entire script trivial to spend.
  if (decoded.length === 1 && (decoded[0] === 1 || decoded[0] === "TRUE")) {
    throw new VtxoVerificationError(
      `Forbidden trivial script (OP_TRUE) in ${txid}`,
      "SECURITY_VIOLATION"
    );
  }

  // ── Standard Ark Exit Policy ──
  // Check for presence of CHECKSEQUENCEVERIFY and CHECKSIG in a valid sequence.
  const hasCSV = decoded.some(op => op === "CHECKSEQUENCEVERIFY");
  const hasCheckSig = decoded.some(op => op === "CHECKSIG" || op === "CHECKSIGVERIFY");

  // ── Submarine Swap HTLC Policies ──
  const hasHash = decoded.some(op => 
    op === "HASH160" || op === "SHA256" || op === "HASH256" || op === "RIPEMD160"
  );
  const hasCLTV = decoded.some(op => op === "CHECKLOCKTIMEVERIFY");

  const isArkStandard = hasCSV && hasCheckSig;
  const isSwapClaim = hasHash && hasCheckSig;
  const isSwapRefund = hasCLTV && hasCheckSig;

  if (!isArkStandard && !isSwapClaim && !isSwapRefund) {
    throw new VtxoVerificationError(
      `Tapleaf script in ${txid} does not follow Ark or HTLC exit policies`,
      "INVALID_ARK_SCRIPT"
    );
  }
}
