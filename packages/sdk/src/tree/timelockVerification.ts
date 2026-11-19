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

import { hex } from "@scure/base";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { Script } from "@scure/btc-signer/script.js";
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

    /** Transaction nVersion (BIP 68/112 relative locktimes apply only when nVersion >= 2). */
    txVersion?: number;
}

/** Current blockchain state needed for satisfiability checks. */
export interface ChainState {
    currentHeight: number;
    currentTime: number;
    /** Block height where the anchoring commitment tx was confirmed (anchoring nodes only). */
    commitmentHeight?: number;
    /** Block header timestamp (seconds) where the anchoring commitment tx was confirmed (anchoring nodes only). */
    commitmentTime?: number;
}

/** Context controlling whether commitment confirmation metadata applies to this transaction's input. */
export interface TimelockSatisfiabilityOptions {
    /**
     * True only when this transaction directly spends the confirmed commitment transaction
     * (`node.ancestor === null`). When false or omitted, commitment height/time is never
     * substituted for an off-chain ancestor's unknown on-chain confirmation age.
     */
    spendsCommitment?: boolean;
}

// ─── Core: Extract Constraints ───────────────────────────────────────────────

export function extractTimelockConstraints(node: DAGNode): TimelockConstraints {
    const tx = node.tx;
    const txVersion = tx.version ?? 2;
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
        // For script-path spends carrying signatures, extract timelocks only from the spent
        // leaf(s) identified by tapScriptSig leafHash so unexecuted alternate leaves (such as a
        // future CLTV refund leaf on a swap claim spend) do not trigger false rejections.
        const spentLeafHashes =
            !isKeyPathSpend && input.tapScriptSig && input.tapScriptSig.length > 0
                ? new Set(input.tapScriptSig.map(([keyInfo]) => hex.encode(keyInfo.leafHash)))
                : null;

        for (const leaf of input.tapLeafScript) {
            const [_cb, scriptWithVersion] = leaf;
            if (!scriptWithVersion || scriptWithVersion.length < 2) continue;

            // Strip trailing leaf version byte (PSBT encoding)
            const scriptBytes = scriptWithVersion.slice(0, -1);
            const leafVersion = scriptWithVersion[scriptWithVersion.length - 1];

            if (spentLeafHashes) {
                const leafHashHex = hex.encode(tapLeafHash(scriptBytes, leafVersion));
                if (!spentLeafHashes.has(leafHashHex)) continue;
            }

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
        txVersion,
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
    decoded: (string | number | bigint | Uint8Array)[],
    csvValues: number[],
    cltvValues: number[],
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
 * Handles OP_0..OP_16 (decoded as numbers/bigints by btc-signer), and byte pushes
 * (decoded as Uint8Array, interpreted as little-endian ScriptNum).
 *
 * NOTE: BIP 68 CSV values fit in 16 bits (0..65535) and CLTV values fit in 32 bits (<= 2^32 - 1).
 * Both are strictly well within JS Number.MAX_SAFE_INTEGER (2^53 - 1). Values exceeding safe integer
 * bounds return null to prevent precision loss on large numbers.
 */
export function resolveScriptNumber(element: string | number | bigint | Uint8Array): number | null {
    if (typeof element === "number") {
        return Number.isSafeInteger(element) ? element : null;
    }
    if (typeof element === "bigint") {
        if (
            element < BigInt(Number.MIN_SAFE_INTEGER) ||
            element > BigInt(Number.MAX_SAFE_INTEGER)
        ) {
            return null;
        }
        return Number(element);
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
        if (i === bytes.length - 1) {
            // Mask out the sign bit (0x80) on the last byte for magnitude
            result += (bytes[i] & 0x7f) * Math.pow(256, i);
        } else {
            result += bytes[i] * Math.pow(256, i);
        }
    }

    // Sign bit is the MSB of the last byte
    if (bytes[bytes.length - 1] & 0x80) {
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
export function validateTimelockConsistency(constraints: TimelockConstraints, txid: string): void {
    const { nLockTime, nSequence, csvValues, cltvValues, sequenceType, isKeyPathSpend } =
        constraints;
    const txVersion = constraints.txVersion ?? 2;

    // If this is a key-path spend, tapscripts do not execute,
    // so script-level OP_CSV/OP_CLTV consistency requirements do not apply.
    if (isKeyPathSpend) return;

    // ── Rule 1: CSV requires txVersion >= 2 and relative timelock enabled ──
    const activeCsvValues: number[] = [];
    for (const csvVal of csvValues) {
        if (csvVal < 0) {
            throw new VtxoVerificationError(
                `Transaction ${txid} has negative OP_CSV operand (${csvVal})`,
                "TIMELOCK_INCONSISTENT",
                { txid, csvVal },
            );
        }
        // BIP 112: if bit 31 (disable flag) is set on the operand, OP_CSV is a NOP
        if ((csvVal & SEQUENCE_LOCKTIME_DISABLE_FLAG) !== 0) continue;
        activeCsvValues.push(csvVal);
    }

    if (activeCsvValues.length > 0) {
        if (txVersion < 2) {
            throw new VtxoVerificationError(
                `Transaction ${txid} uses OP_CSV with nVersion=${txVersion} (< 2, BIP 112 violation)`,
                "TIMELOCK_INCONSISTENT",
                { txid, txVersion, csvValues: activeCsvValues },
            );
        }
        if (sequenceType === "final" || sequenceType === "disabled") {
            throw new VtxoVerificationError(
                `Transaction ${txid} uses OP_CSV but nSequence disables relative timelocks (BIP 68)`,
                "TIMELOCK_INCONSISTENT",
                { txid, nSequence: nSequence.toString(16), csvValues: activeCsvValues },
            );
        }
    }

    // ── Rule 2: CLTV requires a non-zero nLockTime and non-final nSequence ──
    if (cltvValues.length > 0) {
        if (sequenceType === "final") {
            throw new VtxoVerificationError(
                `Transaction ${txid} uses OP_CLTV but nSequence=0xFFFFFFFF (nLockTime disabled by BIP 65)`,
                "TIMELOCK_INCONSISTENT",
                { txid, nSequence: nSequence.toString(16), cltvValues },
            );
        }
        for (const cltvVal of cltvValues) {
            if (cltvVal < 0 || cltvVal > 0xffffffff) {
                throw new VtxoVerificationError(
                    `Transaction ${txid} has out-of-range OP_CLTV operand (${cltvVal})`,
                    "TIMELOCK_INCONSISTENT",
                    { txid, cltvVal },
                );
            }
        }
        if (nLockTime === 0) {
            const maxCltv = Math.max(...cltvValues);
            if (maxCltv > 0) {
                throw new VtxoVerificationError(
                    `Transaction ${txid} uses OP_CLTV (max value=${maxCltv}) but nLockTime=0`,
                    "TIMELOCK_INCONSISTENT",
                    { txid, nLockTime, cltvValues },
                );
            }
        }
    }

    // ── Rule 3: CLTV/nLockTime domain agreement and BIP 65 ordering (cltv <= nLockTime) ──
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
                { txid, cltvVal, nLockTime },
            );
        }

        if (nLockTime > 0 && cltvVal > nLockTime) {
            throw new VtxoVerificationError(
                `Transaction ${txid} has OP_CLTV value (${cltvVal}) > nLockTime (${nLockTime}) (BIP 65 violation)`,
                "TIMELOCK_INCONSISTENT",
                { txid, cltvVal, nLockTime },
            );
        }
    }

    // ── Rule 4: CSV/nSequence type and value agreement ──────────────────
    if (activeCsvValues.length > 0 && sequenceType !== "final" && sequenceType !== "disabled") {
        const seqIsTime = !!(nSequence & SEQUENCE_LOCKTIME_TYPE_FLAG);
        const seqValue = nSequence & SEQUENCE_LOCKTIME_MASK;

        for (const csvVal of activeCsvValues) {
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
                    { txid, csvVal, nSequence: nSequence.toString(16) },
                );
            }

            // CSV operand value must be <= nSequence masked value
            if (csvMasked > seqValue) {
                throw new VtxoVerificationError(
                    `Transaction ${txid} has CSV value (${csvMasked}) > nSequence value (${seqValue})`,
                    "TIMELOCK_INCONSISTENT",
                    { txid, csvMasked, seqValue },
                );
            }
        }
    }
}

// ─── Core: Satisfiability Validation ─────────────────────────────────────────

/**
 * Evaluates conservatively whether all timelock constraints are already mature
 * under the current blockchain state.
 *
 * Valid but immature constraints (future CLTV/nLockTime, immature BIP-68 CSV, or
 * BIP-68 constraints spending an unconfirmed off-chain ancestor whose confirmation
 * height/time is unknown) return `false` with diagnostic notes rather than throwing.
 *
 * Checks:
 *   1. Absolute nLockTime (when nSequence != 0xffffffff) and script OP_CLTV against
 *      current tip height (blocks: matures at `<= tip`) or tip MTP (time: BIP-113 requires
 *      `locktime < MTP`, so a timestamp equal to the tip MTP is still immature).
 *   2. BIP-68 relative nSequence (for nVersion >= 2 on both key-path and script-path
 *      spends, regardless of OP_CSV presence) using the governing masked sequence value
 *      (and matching OP_CSV floor) for both block-based and time-based (512s) delays.
 *   3. Only uses commitmentHeight/commitmentTime when `options.spendsCommitment` is true;
 *      for deeper DAG nodes spending an off-chain ancestor, returns `false`.
 */
export function validateTimelockSatisfiability(
    constraints: TimelockConstraints,
    chainState: ChainState,
    txid: string,
    diagnostics?: string[],
    options?: TimelockSatisfiabilityOptions,
): boolean {
    const {
        nLockTime,
        nSequence,
        cltvValues,
        csvValues,
        lockTimeType,
        sequenceType,
        isKeyPathSpend,
    } = constraints;
    const txVersion = constraints.txVersion ?? 2;
    const spendsCommitment = options?.spendsCommitment === true;

    let satisfied = true;

    // ── Absolute timelock (nLockTime) ───────────────────────────────────
    // Bitcoin consensus enforces nLockTime only when nSequence != 0xffffffff.
    if (nLockTime > 0 && sequenceType !== "final") {
        if (lockTimeType === "blocks" && nLockTime > chainState.currentHeight) {
            satisfied = false;
            diagnostics?.push(
                `  ! VTXO ${txid} has immature nLockTime=${nLockTime} (blocks; chain height is ${chainState.currentHeight}; not immediately broadcastable)`,
            );
        } else if (lockTimeType === "time" && nLockTime >= chainState.currentTime) {
            satisfied = false;
            diagnostics?.push(
                `  ! VTXO ${txid} has immature nLockTime=${nLockTime} (time; tip MTP is ${chainState.currentTime}; not immediately broadcastable)`,
            );
        }
    }

    // ── Script-level OP_CLTV ────────────────────────────────────────────
    if (!isKeyPathSpend) {
        for (const cltvVal of cltvValues) {
            if (cltvVal <= 0) continue;

            if (cltvVal < LOCKTIME_THRESHOLD) {
                if (cltvVal > chainState.currentHeight) {
                    satisfied = false;
                    diagnostics?.push(
                        `  ! VTXO ${txid} OP_CLTV requires block ${cltvVal} (chain height is ${chainState.currentHeight}; not immediately broadcastable)`,
                    );
                }
            } else if (cltvVal >= chainState.currentTime) {
                satisfied = false;
                diagnostics?.push(
                    `  ! VTXO ${txid} OP_CLTV requires time ${cltvVal} (tip MTP is ${chainState.currentTime}; not immediately broadcastable)`,
                );
            }
        }
    }

    // ── Relative timelock (BIP 68 nSequence / BIP 112 OP_CSV) ───────────
    // BIP 68 applies to any nVersion >= 2 transaction whose nSequence has bit 31 clear,
    // regardless of whether the spend is key-path or whether the script contains OP_CSV.
    const activeScriptCsv = !isKeyPathSpend
        ? csvValues.filter((v) => v > 0 && (v & SEQUENCE_LOCKTIME_DISABLE_FLAG) === 0)
        : [];
    const maxBlockCsv = Math.max(
        ...activeScriptCsv
            .filter((v) => (v & SEQUENCE_LOCKTIME_TYPE_FLAG) === 0)
            .map((v) => v & SEQUENCE_LOCKTIME_MASK),
        0,
    );
    const maxTimeCsv = Math.max(
        ...activeScriptCsv
            .filter((v) => (v & SEQUENCE_LOCKTIME_TYPE_FLAG) !== 0)
            .map((v) => v & SEQUENCE_LOCKTIME_MASK),
        0,
    );

    if (
        (maxBlockCsv > 0 || maxTimeCsv > 0) &&
        (txVersion < 2 || sequenceType === "final" || sequenceType === "disabled")
    ) {
        satisfied = false;
        diagnostics?.push(
            `  ! VTXO ${txid} has active OP_CSV constraint but BIP-68 relative locktime is not enabled`,
        );
    }

    const seqValue = nSequence & SEQUENCE_LOCKTIME_MASK;

    if (txVersion >= 2 && sequenceType === "blocks") {
        const requiredBlocks = Math.max(seqValue, maxBlockCsv);
        if (requiredBlocks > 0) {
            if (!spendsCommitment) {
                satisfied = false;
                diagnostics?.push(
                    `  ! VTXO ${txid} has a ${requiredBlocks}-block BIP-68 delay spending an off-chain ancestor (spent parent confirmation depth unknown; not immediately broadcastable)`,
                );
            } else if (chainState.commitmentHeight === undefined) {
                satisfied = false;
                diagnostics?.push(
                    `  ! VTXO ${txid} has a ${requiredBlocks}-block BIP-68 delay (commitment confirmation height unknown; maturity unverified)`,
                );
            } else {
                const depth = chainState.currentHeight - chainState.commitmentHeight;
                if (depth < requiredBlocks) {
                    satisfied = false;
                    const remaining = requiredBlocks - depth;
                    diagnostics?.push(
                        `  ! VTXO ${txid} has a BIP-68 delay of ${requiredBlocks} blocks. Commitment depth is ${depth} (remaining: ${remaining} blocks; not immediately broadcastable)`,
                    );
                }
            }
        }
    } else if (txVersion >= 2 && sequenceType === "time") {
        const requiredUnits = Math.max(seqValue, maxTimeCsv);
        if (requiredUnits > 0) {
            const requiredSeconds = requiredUnits * 512;
            if (!spendsCommitment) {
                satisfied = false;
                diagnostics?.push(
                    `  ! VTXO ${txid} has a ${requiredSeconds}s BIP-68 delay spending an off-chain ancestor (spent parent confirmation time unknown; not immediately broadcastable)`,
                );
            } else if (chainState.commitmentTime === undefined) {
                satisfied = false;
                diagnostics?.push(
                    `  ! VTXO ${txid} has a ${requiredSeconds}s BIP-68 delay (commitment confirmation time unknown; maturity unverified)`,
                );
            } else {
                // Consensus guarantees block header nTime > prior-block MTP, so comparing
                // tip MTP against commitmentTime + requiredSeconds is conservative and never
                // reports maturity early.
                const elapsed = chainState.currentTime - chainState.commitmentTime;
                if (elapsed < requiredSeconds) {
                    satisfied = false;
                    const remaining = requiredSeconds - elapsed;
                    diagnostics?.push(
                        `  ! VTXO ${txid} has a BIP-68 delay of ${requiredSeconds}s. Elapsed MTP since commitment is ${elapsed}s (remaining: ${remaining}s; not immediately broadcastable)`,
                    );
                }
            }
        }
    }

    return satisfied;
}

// ─── Entry Point: Recursive DAG Validation ───────────────────────────────────

/**
 * Recursively validates all timelock constraints across the entire DAG.
 *
 * For each node:
 *   1. Extracts timelock constraints.
 *   2. Validates internal consistency (throws TIMELOCK_INCONSISTENT on consensus violations).
 *   3. Conservatively checks satisfiability against the current chain state.
 *
 * @param node       The node of the DAG to validate.
 * @param chainState Current blockchain state (height + MTP).
 * @param diagnostics Optional diagnostic output array.
 * @returns true if all timelocks are proven mature/satisfied; false if immature or unknown.
 * @throws VtxoVerificationError on internal timelock inconsistency.
 */
export function verifyNodeTimelocks(
    node: DAGNode,
    chainState: ChainState,
    diagnostics?: string[],
): boolean {
    const constraints = extractTimelockConstraints(node);

    const hasTimelocks =
        constraints.nLockTime > 0 ||
        constraints.sequenceType !== "final" ||
        constraints.csvValues.length > 0 ||
        constraints.cltvValues.length > 0;

    if (hasTimelocks) {
        validateTimelockConsistency(constraints, node.txid);
        return validateTimelockSatisfiability(constraints, chainState, node.txid, diagnostics, {
            spendsCommitment: node.ancestor === null,
        });
    }
    return true;
}

export function verifyDAGTimelocks(
    rootNode: DAGNode,
    chainState: ChainState,
    diagnostics?: string[],
): boolean {
    let allSatisfied = true;
    const stack: DAGNode[] = [rootNode];

    while (stack.length > 0) {
        const current = stack.pop()!;
        const satisfied = verifyNodeTimelocks(current, chainState, diagnostics);
        if (!satisfied) {
            allSatisfied = false;
        }

        // Add children to stack for iterative processing
        for (const child of current.children.values()) {
            stack.push(child);
        }
    }
    return allSatisfied;
}
