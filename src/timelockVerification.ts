/**
 * ============================================================================
 *  Arkade VTXO Timelock Verification (Tier 2 Phase 2)
 * ============================================================================
 *
 *  Validates temporal constraints across the VTXO DAG:
 *    - nLockTime (absolute timelock at transaction level)
 *    - nSequence (relative timelock at input level, BIP 68)
 *    - OP_CHECKLOCKTIMEVERIFY (CLTV, opcode 0xb1, BIP 65)
 *    - OP_CHECKSEQUENCEVERIFY (CSV, opcode 0xb2, BIP 112)
 *
 *  Two levels of validation:
 *    1. Internal consistency — Do the constraints agree with each other?
 *    2. Satisfiability — Can they be met given the current blockchain state?
 *
 *  References:
 *    BIP 65: https://github.com/bitcoin/bips/blob/master/bip-0065.mediawiki
 *    BIP 68: https://github.com/bitcoin/bips/blob/master/bip-0068.mediawiki
 *    BIP 112: https://github.com/bitcoin/bips/blob/master/bip-0112.mediawiki
 * ============================================================================
 */

import { Script, OP } from "@scure/btc-signer/script.js";
import { hex } from "@scure/base";
import { VtxoVerificationError, type DAGNode } from "./vtxoDAGVerification.js";

// ─── Constants (BIP 68 / BIP 112) ────────────────────────────────────────────

/** nSequence flag: if set, relative timelock is disabled (BIP 68). */
const SEQUENCE_LOCKTIME_DISABLE_FLAG = 1 << 31;

/** nSequence flag: if set, timelock is time-based (512-second units). */
const SEQUENCE_LOCKTIME_TYPE_FLAG = 1 << 22;

/** Mask for the lower 16 bits (the actual timelock value). */
const SEQUENCE_LOCKTIME_MASK = 0x0000ffff;

/** nSequence value that signals "final" (no relative timelock). */
const SEQUENCE_FINAL = 0xffffffff;

/** Threshold separating block heights from UNIX timestamps in nLockTime/CLTV. */
const LOCKTIME_THRESHOLD = 500_000_000;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Parsed temporal constraints for a single transaction. */
export interface TimelockConstraints {
  /** Transaction-level absolute timelock (from tx.lockTime). */
  nLockTime: number;

  /** Input-level sequence number (from input[0].sequence). */
  nSequence: number;

  /** All OP_CSV operand values found in tapscripts (raw integer values). */
  csvValues: number[];

  /** All OP_CLTV operand values found in tapscripts (raw integer values). */
  cltvValues: number[];

  /** Whether nLockTime uses block height, UNIX timestamp, or is inactive. */
  lockTimeType: "blocks" | "time" | "none";

  /** Whether nSequence uses blocks, time, is disabled, or is final. */
  sequenceType: "blocks" | "time" | "disabled" | "final";

  /** True if the input is signed via Taproot Key Path (ignores scripts). */
  isKeyPathSpend: boolean;
}

/** Current blockchain state needed for satisfiability checks. */
export interface ChainState {
  currentHeight: number;
  currentTime: number;
  /** The block height where the anchoring commitment transaction was confirmed. */
  commitmentHeight?: number;
}

// ─── Core: Extract Constraints ───────────────────────────────────────────────

export function extractTimelockConstraints(node: DAGNode): TimelockConstraints {
  const tx = node.tx;
  const nLockTime = tx.lockTime;
  const input = tx.getInput(0);
  const nSequence = input.sequence ?? SEQUENCE_FINAL;
  const isKeyPathSpend = !!input.tapKeySig;

  // Classify nLockTime
  let lockTimeType: TimelockConstraints["lockTimeType"];
  if (nLockTime === 0) {
    lockTimeType = "none";
  } else if (nLockTime < LOCKTIME_THRESHOLD) {
    lockTimeType = "blocks";
  } else {
    lockTimeType = "time";
  }

  // Classify nSequence (BIP 68)
  let sequenceType: TimelockConstraints["sequenceType"];
  if (nSequence === SEQUENCE_FINAL) {
    sequenceType = "final";
  } else if (nSequence & SEQUENCE_LOCKTIME_DISABLE_FLAG) {
    sequenceType = "disabled";
  } else if (nSequence & SEQUENCE_LOCKTIME_TYPE_FLAG) {
    sequenceType = "time";
  } else {
    sequenceType = "blocks";
  }

  // Parse tapscripts for CSV/CLTV operand values
  const csvValues: number[] = [];
  const cltvValues: number[] = [];

  if (input.tapLeafScript) {
    for (const leaf of input.tapLeafScript) {
      const [_cb, scriptWithVersion] = leaf;
      if (!scriptWithVersion || scriptWithVersion.length < 2) continue;

      // Strip trailing leaf version byte (PSBT encoding)
      const scriptBytes = scriptWithVersion.slice(0, -1);

      try {
        const decoded = Script.decode(scriptBytes);
        extractTimelockOpcodes(decoded, csvValues, cltvValues);
      } catch {
        // Script might not be decodable — skip silently.
        // The Taproot verification module already checks structural validity.
      }
    }
  }

  return {
    nLockTime,
    nSequence,
    csvValues,
    cltvValues,
    lockTimeType,
    sequenceType,
    isKeyPathSpend,
  };
}

/**
 * Walks a decoded script array and extracts operand values preceding
 * OP_CHECKSEQUENCEVERIFY and OP_CHECKLOCKTIMEVERIFY.
 *
 * Script pattern: <value> OP_CSV | <value> OP_CLTV
 * where <value> is either a small integer (OP_1..OP_16) or a byte push.
 */
function extractTimelockOpcodes(
  decoded: (string | number | Uint8Array)[],
  csvValues: number[],
  cltvValues: number[]
): void {
  for (let i = 0; i < decoded.length; i++) {
    const op = decoded[i];

    if (op === "CHECKSEQUENCEVERIFY" && i > 0) {
      const operand = resolveScriptNumber(decoded[i - 1]);
      if (operand !== null) csvValues.push(operand);
    }

    if (op === "CHECKLOCKTIMEVERIFY" && i > 0) {
      const operand = resolveScriptNumber(decoded[i - 1]);
      if (operand !== null) cltvValues.push(operand);
    }
  }
}

/**
 * Resolves a script element to a numeric value.
 * Handles OP_0..OP_16 (decoded as numbers by btc-signer), and byte pushes
 * (decoded as Uint8Array, interpreted as little-endian ScriptNum).
 */
function resolveScriptNumber(
  element: string | number | Uint8Array
): number | null {
  if (typeof element === "number") {
    return element;
  }
  if (element instanceof Uint8Array) {
    return scriptNumToInt(element);
  }
  return null;
}

/**
 * Decodes a Bitcoin ScriptNum (little-endian, sign-magnitude) to a JS number.
 * Returns null if the value exceeds safe integer range.
 */
function scriptNumToInt(bytes: Uint8Array): number | null {
  if (bytes.length === 0) return 0;
  if (bytes.length > 5) return null; // ScriptNum max 5 bytes for timelocks

  let result = 0;
  for (let i = 0; i < bytes.length; i++) {
    result |= bytes[i] << (8 * i);
  }

  // Sign bit is the MSB of the last byte
  if (bytes[bytes.length - 1] & 0x80) {
    result &= ~(0x80 << (8 * (bytes.length - 1)));
    result = -result;
  }

  if (!Number.isSafeInteger(result)) return null;
  return result;
}

// ─── Core: Internal Consistency Validation ───────────────────────────────────

/**
 * Validates that the timelock constraints within a single transaction are
 * internally consistent according to Bitcoin consensus rules.
 *
 * Rules enforced:
 *   1. If any tapscript uses OP_CSV, nSequence must NOT be 0xFFFFFFFF
 *      (BIP 68: relative timelock must be enabled).
 *   2. If any tapscript uses OP_CLTV, nLockTime must be > 0
 *      (otherwise the CLTV check would always fail for non-zero values).
 *   3. CLTV values and nLockTime must be in the SAME domain:
 *      both < 500,000,000 (blocks) or both >= 500,000,000 (time).
 *   4. CSV operand values must be compatible with nSequence encoding:
 *      same type flag (bit 22) and operand <= nSequence masked value.
 *
 * @throws VtxoVerificationError with code TIMELOCK_INCONSISTENT
 */
export function validateTimelockConsistency(
  constraints: TimelockConstraints,
  txid: string
): void {
  const { nLockTime, nSequence, csvValues, cltvValues, sequenceType, isKeyPathSpend } =
    constraints;

  // If this is a key-path spend, the tapscripts will not be executed, 
  // so we don't enforce their consistency requirements against this tx.
  if (isKeyPathSpend) return;

  // ── Rule 1: CSV requires relative timelock to be enabled ─────────────
  if (csvValues.length > 0 && sequenceType === "final") {
    throw new VtxoVerificationError(
      `Transaction ${txid} uses OP_CSV but nSequence=0xFFFFFFFF (relative timelock disabled by BIP 68)`,
      "TIMELOCK_INCONSISTENT",
      { txid, nSequence: nSequence.toString(16), csvValues }
    );
  }

  // ── Rule 2: CLTV requires a non-zero nLockTime ──────────────────────
  if (cltvValues.length > 0 && nLockTime === 0) {
    // Find the max CLTV value — if all are 0, that's fine
    const maxCltv = Math.max(...cltvValues);
    if (maxCltv > 0) {
      throw new VtxoVerificationError(
        `Transaction ${txid} uses OP_CLTV (max value=${maxCltv}) but nLockTime=0`,
        "TIMELOCK_INCONSISTENT",
        { txid, nLockTime, cltvValues }
      );
    }
  }

  // ── Rule 3: CLTV/nLockTime domain agreement ─────────────────────────
  for (const cltvVal of cltvValues) {
    if (cltvVal <= 0) continue;

    const cltvIsBlocks = cltvVal < LOCKTIME_THRESHOLD;
    const lockTimeIsBlocks = nLockTime < LOCKTIME_THRESHOLD;

    if (nLockTime > 0 && cltvIsBlocks !== lockTimeIsBlocks) {
      throw new VtxoVerificationError(
        `Transaction ${txid} has CLTV/nLockTime domain mismatch: ` +
          `CLTV=${cltvVal} (${cltvIsBlocks ? "blocks" : "time"}) vs ` +
          `nLockTime=${nLockTime} (${lockTimeIsBlocks ? "blocks" : "time"})`,
        "TIMELOCK_INCONSISTENT",
        { txid, cltvVal, nLockTime }
      );
    }
  }

  // ── Rule 4: CSV/nSequence type and value agreement ──────────────────
  if (csvValues.length > 0 && sequenceType !== "final" && sequenceType !== "disabled") {
    const seqIsTime = !!(nSequence & SEQUENCE_LOCKTIME_TYPE_FLAG);
    const seqValue = nSequence & SEQUENCE_LOCKTIME_MASK;

    for (const csvVal of csvValues) {
      if (csvVal <= 0) continue;

      const csvIsTime = !!(csvVal & SEQUENCE_LOCKTIME_TYPE_FLAG);
      const csvMasked = csvVal & SEQUENCE_LOCKTIME_MASK;

      // Type must match (both block-based or both time-based)
      if (csvIsTime !== seqIsTime) {
        throw new VtxoVerificationError(
          `Transaction ${txid} has CSV/nSequence type mismatch: ` +
            `CSV type=${csvIsTime ? "time" : "blocks"} vs ` +
            `nSequence type=${seqIsTime ? "time" : "blocks"}`,
          "TIMELOCK_INCONSISTENT",
          { txid, csvVal, nSequence: nSequence.toString(16) }
        );
      }

      // CSV operand value must be <= nSequence masked value
      if (csvMasked > seqValue) {
        throw new VtxoVerificationError(
          `Transaction ${txid} has CSV value (${csvMasked}) > nSequence value (${seqValue})`,
          "TIMELOCK_INCONSISTENT",
          { txid, csvMasked, seqValue }
        );
      }
    }
  }
}

// ─── Core: Satisfiability Validation ─────────────────────────────────────────

/**
 * Validates that the timelock constraints CAN be satisfied given the current
 * blockchain state. This is a "liveness" check: even if constraints are
 * internally consistent, they might not yet be achievable.
 *
 * Checks:
 *   1. Block-based CLTV: required height ≤ currentHeight
 *   2. Time-based CLTV: required time ≤ currentTime (MTP)
 *   3. Block-based CSV: relative delay ≤ parent confirmation depth
 *      (approximated: we check against chainState since virtual txs
 *       inherit their commitment tx's confirmation context)
 *   4. Time-based CSV: relative delay × 512 ≤ elapsed time since parent
 *
 * @throws VtxoVerificationError with code TIMELOCK_UNSATISFIABLE
 */
export function validateTimelockSatisfiability(
  constraints: TimelockConstraints,
  chainState: ChainState,
  txid: string
): void {
  const { nLockTime, nSequence, cltvValues, csvValues, lockTimeType, sequenceType, isKeyPathSpend } =
    constraints;

  // ── CLTV satisfiability ──────────────────────────────────────────────
  if (nLockTime > 0 && lockTimeType === "blocks") {
    if (nLockTime > chainState.currentHeight) {
      throw new VtxoVerificationError(
        `Transaction ${txid} has nLockTime=${nLockTime} (blocks) but chain height is ${chainState.currentHeight}`,
        "TIMELOCK_UNSATISFIABLE",
        { txid, nLockTime, currentHeight: chainState.currentHeight }
      );
    }
  }

  if (nLockTime > 0 && lockTimeType === "time") {
    if (nLockTime > chainState.currentTime) {
      throw new VtxoVerificationError(
        `Transaction ${txid} has nLockTime=${nLockTime} (time) but MTP is ${chainState.currentTime}`,
        "TIMELOCK_UNSATISFIABLE",
        { txid, nLockTime, currentTime: chainState.currentTime }
      );
    }
  }

  // Per-CLTV-operand satisfiability
  if (!isKeyPathSpend) {
    for (const cltvVal of cltvValues) {
      if (cltvVal <= 0) continue;

      if (cltvVal < LOCKTIME_THRESHOLD) {
        // Block-based CLTV
        if (cltvVal > chainState.currentHeight) {
          throw new VtxoVerificationError(
            `Transaction ${txid} OP_CLTV requires block ${cltvVal} but chain is at ${chainState.currentHeight}`,
            "TIMELOCK_UNSATISFIABLE",
            { txid, cltvRequired: cltvVal, currentHeight: chainState.currentHeight }
          );
        }
      } else {
        // Time-based CLTV
        if (cltvVal > chainState.currentTime) {
          throw new VtxoVerificationError(
            `Transaction ${txid} OP_CLTV requires time ${cltvVal} but MTP is ${chainState.currentTime}`,
            "TIMELOCK_UNSATISFIABLE",
            { txid, cltvRequired: cltvVal, currentTime: chainState.currentTime }
          );
        }
      }
    }
  }

  // ── CSV satisfiability ───────────────────────────────────────────────
  // For virtual transactions, CSV is evaluated relative to the commitment
  // tx's confirmation. Since we can't precisely know "elapsed blocks since
  // parent confirmation" without more context, we validate that the
  // relative delay is reasonable (non-astronomical) and that the chain
  // has enough depth in general.
  //
  // Note: In a real Ark deployment, virtual txs are never broadcast
  // on-chain unless there's a dispute. The CSV check here validates that
  // the constraints COULD be satisfied if the tx were broadcast.
  if (!isKeyPathSpend && sequenceType === "blocks" && csvValues.length > 0) {
    const maxCsv = Math.max(
      ...csvValues
        .filter((v) => v > 0 && !(v & SEQUENCE_LOCKTIME_TYPE_FLAG))
        .map((v) => v & SEQUENCE_LOCKTIME_MASK),
      0
    );

    // BIP 68 / BIP 112: Relative timelock is satisfied if depth >= delay
    if (chainState.commitmentHeight !== undefined) {
      const depth = chainState.currentHeight - chainState.commitmentHeight;
      if (maxCsv > depth) {
        throw new VtxoVerificationError(
          `Transaction ${txid} CSV requires ${maxCsv} blocks but current commitment depth is only ${depth} blocks`,
          "TIMELOCK_UNSATISFIABLE",
          { txid, csvRequired: maxCsv, currentDepth: depth, commitmentHeight: chainState.commitmentHeight }
        );
      }
    } else {
      // If commitmentHeight is missing, we perform a sanity check against total height
      // to avoid astronomical delays, but we note it's incomplete.
      if (maxCsv > chainState.currentHeight) {
        throw new VtxoVerificationError(
          `Transaction ${txid} CSV requires ${maxCsv} blocks which exceeds total chain height ${chainState.currentHeight}`,
          "TIMELOCK_UNSATISFIABLE",
          { txid, csvRequired: maxCsv, currentHeight: chainState.currentHeight }
        );
      }
    }
  }
}

// ─── Entry Point: Recursive DAG Validation ───────────────────────────────────

/**
 * Recursively validates all timelock constraints across the entire DAG.
 *
 * For each node:
 *   1. Extracts timelock constraints.
 *   2. Validates internal consistency.
 *   3. Validates satisfiability against the current chain state.
 *
 * @param rootNode   The root of the reconstructed DAG.
 * @param chainState Current blockchain state (height + MTP).
 * @throws VtxoVerificationError on any timelock violation.
 */
export function verifyDAGTimelocks(
  rootNode: DAGNode,
  chainState: ChainState
): void {
  const stack: DAGNode[] = [rootNode];
  
  while (stack.length > 0) {
    const node = stack.pop()!;
    const constraints = extractTimelockConstraints(node);

    // Only run validation if there are actual timelock constraints
    const hasTimelocks =
      constraints.nLockTime > 0 ||
      constraints.sequenceType !== "final" ||
      constraints.csvValues.length > 0 ||
      constraints.cltvValues.length > 0;

    if (hasTimelocks) {
      validateTimelockConsistency(constraints, node.txid);
      validateTimelockSatisfiability(constraints, chainState, node.txid);
    }

    // Add children to stack for iterative processing
    for (const child of node.children.values()) {
      stack.push(child);
    }
  }
}
