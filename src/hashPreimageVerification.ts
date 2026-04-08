/**
 * ============================================================================
 *  Arkade VTXO Hash Preimage Verification (Tier 2 Phase 3)
 * ============================================================================
 *
 *  Validates hash preimage conditions in tapscripts.
 *
 *  When a tapscript contains hash-lock conditions such as:
 *    OP_SHA256 <hash> OP_EQUAL(VERIFY)
 *    OP_HASH160 <hash> OP_EQUAL(VERIFY)
 *    OP_HASH256 <hash> OP_EQUAL(VERIFY)
 *    OP_RIPEMD160 <hash> OP_EQUAL(VERIFY)
 *
 *  This module extracts the expected hash values, identifies the
 *  corresponding preimage from the witness stack, computes the hash,
 *  and verifies that it matches the script's commitment.
 *
 *  Critical for submarine swap (HTLC) verification:
 *    Boltz-style Ark↔Lightning swaps embed HASH160 conditions in
 *    tapscript claim leaves. The preimage revealed on-chain must
 *    satisfy the hash-lock to prove atomic swap completion.
 *
 *  Dependencies: @noble/hashes, @scure/btc-signer
 * ============================================================================
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { Script } from "@scure/btc-signer/script.js";
import { hex } from "@scure/base";
import { VtxoVerificationError, type DAGNode } from "./vtxoDAGVerification.js";

// ─── Supported Hash Operations ───────────────────────────────────────────────

/** Supported hash opcodes and their implementations. */
const HASH_OPS: Record<string, (preimage: Uint8Array) => Uint8Array> = {
  SHA256: (data) => sha256(data),
  HASH160: (data) => ripemd160(sha256(data)),
  HASH256: (data) => sha256(sha256(data)),
  RIPEMD160: (data) => ripemd160(data),
};

// ─── Types ───────────────────────────────────────────────────────────────────

/** A hash condition extracted from a script. */
export interface HashCondition {
  /** The hash opcode used (SHA256, HASH160, etc.). */
  opcode: string;

  /** The expected hash value from the script. */
  expectedHash: Uint8Array;

  /** Position in the decoded script where the opcode appears. */
  opcodeIndex: number;
}

/** Result of a hash preimage verification. */
export interface PreimageVerificationResult {
  /** Whether the preimage satisfies the hash condition. */
  valid: boolean;

  /** The hash opcode used. */
  opcode: string;

  /** The provided preimage (hex). */
  preimage: string;

  /** The computed hash of the preimage (hex). */
  computedHash: string;

  /** The expected hash from the script (hex). */
  expectedHash: string;
}

// ─── Core: Extract Hash Conditions from Scripts ──────────────────────────────

/**
 * Parses a decoded script and extracts all hash-lock conditions.
 *
 * Recognized patterns:
 *   OP_SHA256 <32-byte hash> OP_EQUAL / OP_EQUALVERIFY
 *   OP_HASH160 <20-byte hash> OP_EQUAL / OP_EQUALVERIFY
 *   OP_HASH256 <32-byte hash> OP_EQUAL / OP_EQUALVERIFY
 *   OP_RIPEMD160 <20-byte hash> OP_EQUAL / OP_EQUALVERIFY
 *
 * The pattern is: <hash_opcode> <push_data> <EQUAL|EQUALVERIFY>
 * But in the witness stack, the preimage is pushed BEFORE the hash opcode.
 * In the script itself, the pattern is:
 *   <hash_opcode> <expected_hash> <EQUAL|EQUALVERIFY>
 *
 * @param decoded  The decoded script elements from Script.decode().
 * @returns An array of HashCondition objects.
 */
export function extractHashConditions(
  decoded: (string | number | Uint8Array)[]
): HashCondition[] {
  const conditions: HashCondition[] = [];

  for (let i = 0; i < decoded.length; i++) {
    const op = decoded[i];

    // Check if this is a hash opcode
    if (typeof op === "string" && op in HASH_OPS) {
      // Next element should be the expected hash (byte push)
      if (i + 1 < decoded.length && decoded[i + 1] instanceof Uint8Array) {
        // And optionally followed by EQUAL or EQUALVERIFY
        const afterHash = i + 2 < decoded.length ? decoded[i + 2] : null;
        if (
          afterHash === "EQUAL" ||
          afterHash === "EQUALVERIFY"
        ) {
          conditions.push({
            opcode: op,
            expectedHash: decoded[i + 1] as Uint8Array,
            opcodeIndex: i,
          });
        }
      }
    }
  }

  return conditions;
}

// ─── Core: Verify a Preimage Against a Hash Condition ────────────────────────

/**
 * Verifies that a preimage satisfies a hash condition.
 *
 * @param preimage   The preimage bytes to verify.
 * @param condition  The hash condition extracted from the script.
 * @returns A PreimageVerificationResult.
 */
export function verifyPreimage(
  preimage: Uint8Array,
  condition: HashCondition
): PreimageVerificationResult {
  const hashFn = HASH_OPS[condition.opcode];
  if (!hashFn) {
    return {
      valid: false,
      opcode: condition.opcode,
      preimage: hex.encode(preimage),
      computedHash: "",
      expectedHash: hex.encode(condition.expectedHash),
    };
  }

  const computedHash = hashFn(preimage);

  const valid =
    computedHash.length === condition.expectedHash.length &&
    computedHash.every((b, i) => b === condition.expectedHash[i]);

  return {
    valid,
    opcode: condition.opcode,
    preimage: hex.encode(preimage),
    computedHash: hex.encode(computedHash),
    expectedHash: hex.encode(condition.expectedHash),
  };
}

// ─── Core: Verify Hash Conditions in Tapscripts ─────────────────────────────

/**
 * Extracts and verifies all hash preimage conditions in a DAG node's tapscripts.
 *
 * For each tapscript leaf containing a hash condition (SHA256, HASH160, etc.),
 * this function searches the witness stack for a candidate preimage and
 * verifies it against the script's expected hash.
 *
 * @param node  The DAG node to verify.
 * @param witnessPreimages  Optional map of (expected hash hex → preimage bytes)
 *                          for external preimage supply (e.g., from the ASP).
 * @throws VtxoVerificationError if a hash condition is found but the preimage
 *         does not satisfy it.
 */
export function verifyNodeHashPreimages(
  node: DAGNode,
  witnessPreimages?: Map<string, Uint8Array>
): void {
  const input = node.tx.getInput(0);

  if (!input.tapLeafScript) return;

  for (const leaf of input.tapLeafScript) {
    const [_cb, scriptWithVersion] = leaf;
    if (!scriptWithVersion || scriptWithVersion.length < 2) continue;

    const scriptBytes = scriptWithVersion.slice(0, -1);

    let decoded: (string | number | Uint8Array)[];
    try {
      decoded = Script.decode(scriptBytes);
    } catch {
      continue;
    }

    const conditions = extractHashConditions(decoded);
    if (conditions.length === 0) continue;

    for (const condition of conditions) {
      const hashHex = hex.encode(condition.expectedHash);

      // If no preimage was supplied, we fail by default for security.
      // HTLC verification should not be skipped if the logic requires it.
      if (!witnessPreimages || !witnessPreimages.has(hashHex)) {
          throw new VtxoVerificationError(
            `Hash condition (${condition.opcode}) found in ${node.txid} but no preimage was supplied for verification`,
            "MISSING_HASH_PREIMAGE",
            { txid: node.txid, hash: hashHex }
          );
      }

      const preimage = witnessPreimages.get(hashHex)!;
      const result = verifyPreimage(preimage, condition);
      if (!result.valid) {
        throw new VtxoVerificationError(
          `Hash preimage verification failed for ${condition.opcode} in tx ${node.txid}`,
          "INVALID_HASH_PREIMAGE",
          {
            txid: node.txid,
            opcode: condition.opcode,
            computedHash: result.computedHash,
            expectedHash: result.expectedHash,
          }
        );
      }
    }
  }
}

// ─── Entry Point: Recursive DAG Verification ────────────────────────────────

/**
 * Recursively verifies hash preimage conditions across the entire DAG.
 *
 * @param rootNode         The root of the reconstructed DAG.
 * @param witnessPreimages Optional preimage supply for hash-lock verification.
 */
export function verifyDAGHashPreimages(
  rootNode: DAGNode,
  witnessPreimages?: Map<string, Uint8Array>
): void {
  const stack: DAGNode[] = [rootNode];
  
  while (stack.length > 0) {
    const node = stack.pop()!;
    // 1. Verify preimages for the current node
    verifyNodeHashPreimages(node, witnessPreimages);

    // 2. Add children to stack for iterative processing
    for (const child of node.children.values()) {
      stack.push(child);
    }
  }
}
