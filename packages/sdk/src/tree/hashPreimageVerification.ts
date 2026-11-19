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
import { ScriptNum } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { Script } from "@scure/btc-signer/script.js";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import type { Transaction } from "../utils/transaction.js";
import { ConditionWitness, getArkPsbtFields } from "../utils/unknownFields.js";
import { resolveScriptNumber } from "./timelockVerification.js";
import { VtxoVerificationError, type DAGNode } from "./vtxoDAGVerification.js";

// ─── Supported Hash Operations & Tapscript Witness Size Limits ───────────────

/**
 * Bitcoin Core standard Tapscript relay policy limit (`MAX_STANDARD_TAPSCRIPT_STACK_ITEM_SIZE`).
 * Witness stack items above 80 bytes (excluding the script and control block) are rejected by
 * default nodes with `bad-witness-nonstandard`, so sovereign exit claims must stay within 80 bytes
 * to remain broadcastable on standard Bitcoin Core nodes.
 */
export const MAX_STANDARD_TAPSCRIPT_WITNESS_ITEM_SIZE = 80;

/**
 * BIP-342 Tapscript consensus stack element limit (`MAX_SCRIPT_ELEMENT_SIZE`).
 * Witness stack items above 520 bytes are consensus-invalid (`SCRIPT_ERR_PUSH_SIZE`).
 */
export const MAX_TAPSCRIPT_CONSENSUS_WITNESS_ITEM_SIZE = 520;

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
    decoded: (string | number | bigint | Uint8Array)[],
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
                if (afterHash === "EQUAL" || afterHash === "EQUALVERIFY") {
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
    condition: HashCondition,
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

// ─── Core: Verify Condition Witness & Hash Conditions in Tapscripts ──────────

interface ParsedSpentCondition {
    hashCondition: HashCondition;
    expectedPreimageSize?: number;
}

function isHashOp(op: unknown): op is string {
    return typeof op === "string" && op in HASH_OPS;
}

function parseMinimalSizeOperand(op: string | number | bigint | Uint8Array): number | null {
    if (typeof op === "number") {
        return Number.isInteger(op) && op >= 0 && op <= 16 ? op : null;
    }
    if (op instanceof Uint8Array) {
        const size = resolveScriptNumber(op);
        if (size === null || size < 0) return null;
        return equalBytes(op, ScriptNum().encode(BigInt(size))) ? size : null;
    }
    return null;
}

function hasUnsupportedLeadingCheckSigAdd(ops: (string | number | bigint | Uint8Array)[]): boolean {
    for (const op of ops) {
        if (op === "CHECKSIG" || op === "CHECKSIGVERIFY") return false;
        if (op === "CHECKSIGADD") return true;
    }
    return false;
}

/**
 * Parses the condition prefix of a spent tapleaf and fails closed on any condition
 * that this verifier cannot prove satisfiable against sovereign exit witness assembly.
 *
 * Returns `null` for unconditional leaves (plain multisig, CSV exit, CLTV refund).
 * Throws `UNSUPPORTED_CONDITION_SCRIPT` for any unrecognized condition prefix or
 * hash-after-signature layout incompatible with `[...sigs, ...condition, script, cb]`.
 */
function parseSpentLeafCondition(
    decoded: (string | number | bigint | Uint8Array)[],
    txid: string,
): ParsedSpentCondition | null {
    const verifyIdx = decoded.lastIndexOf("VERIFY");
    if (verifyIdx !== -1) {
        const conditionOps = decoded.slice(0, verifyIdx);
        const tailOps = decoded.slice(verifyIdx + 1);

        if (tailOps.some(isHashOp) || hasUnsupportedLeadingCheckSigAdd(tailOps)) {
            throw new VtxoVerificationError(
                `Transaction ${txid} contains unsupported opcodes after VERIFY`,
                "UNSUPPORTED_CONDITION_SCRIPT",
                { txid },
            );
        }

        // Pattern 1: <HASH_OP> <expectedHash> EQUAL VERIFY <tail>
        if (
            conditionOps.length === 3 &&
            isHashOp(conditionOps[0]) &&
            conditionOps[1] instanceof Uint8Array &&
            conditionOps[2] === "EQUAL"
        ) {
            return {
                hashCondition: {
                    opcode: conditionOps[0],
                    expectedHash: conditionOps[1],
                    opcodeIndex: 0,
                },
            };
        }

        // Pattern 2 (VHTLC v2 / BOLT3): SIZE <N> EQUALVERIFY <HASH_OP> <expectedHash> EQUAL VERIFY <tail>
        if (
            conditionOps.length === 6 &&
            conditionOps[0] === "SIZE" &&
            conditionOps[2] === "EQUALVERIFY" &&
            isHashOp(conditionOps[3]) &&
            conditionOps[4] instanceof Uint8Array &&
            conditionOps[5] === "EQUAL"
        ) {
            const expectedSize = parseMinimalSizeOperand(conditionOps[1]);
            if (expectedSize !== null) {
                return {
                    expectedPreimageSize: expectedSize,
                    hashCondition: {
                        opcode: conditionOps[3],
                        expectedHash: conditionOps[4],
                        opcodeIndex: 3,
                    },
                };
            }
        }

        throw new VtxoVerificationError(
            `Transaction ${txid} spends a conditional tapleaf with an unsupported condition script`,
            "UNSUPPORTED_CONDITION_SCRIPT",
            { txid },
        );
    }

    // Direct EQUALVERIFY prefix without trailing standalone VERIFY:
    // Pattern 3: <HASH_OP> <expectedHash> EQUALVERIFY <tail>
    if (
        decoded.length > 3 &&
        isHashOp(decoded[0]) &&
        decoded[1] instanceof Uint8Array &&
        decoded[2] === "EQUALVERIFY"
    ) {
        const tailOps = decoded.slice(3);
        if (tailOps.some(isHashOp) || hasUnsupportedLeadingCheckSigAdd(tailOps)) {
            throw new VtxoVerificationError(
                `Transaction ${txid} contains unsupported hash or signing tail after EQUALVERIFY`,
                "UNSUPPORTED_CONDITION_SCRIPT",
                { txid },
            );
        }
        return {
            hashCondition: {
                opcode: decoded[0],
                expectedHash: decoded[1],
                opcodeIndex: 0,
            },
        };
    }

    // Pattern 4: SIZE <N> EQUALVERIFY <HASH_OP> <expectedHash> EQUALVERIFY <tail>
    if (
        decoded.length > 6 &&
        decoded[0] === "SIZE" &&
        decoded[2] === "EQUALVERIFY" &&
        isHashOp(decoded[3]) &&
        decoded[4] instanceof Uint8Array &&
        decoded[5] === "EQUALVERIFY"
    ) {
        const expectedSize = parseMinimalSizeOperand(decoded[1]);
        const tailOps = decoded.slice(6);
        if (
            expectedSize !== null &&
            !tailOps.some(isHashOp) &&
            !hasUnsupportedLeadingCheckSigAdd(tailOps)
        ) {
            return {
                expectedPreimageSize: expectedSize,
                hashCondition: {
                    opcode: decoded[3],
                    expectedHash: decoded[4],
                    opcodeIndex: 3,
                },
            };
        }
        throw new VtxoVerificationError(
            `Transaction ${txid} spends a conditional tapleaf with an unsupported SIZE/hash condition`,
            "UNSUPPORTED_CONDITION_SCRIPT",
            { txid },
        );
    }

    // Any remaining hash opcode (e.g. `<pk> CHECKSIGVERIFY HASH160 <hash> EQUAL`) expects
    // witness ordering incompatible with sovereign exit's `[...sigs, ...condition, script, cb]`.
    if (decoded.some(isHashOp)) {
        throw new VtxoVerificationError(
            `Transaction ${txid} spends a hash-locked tapleaf with an unsupported condition/witness layout`,
            "UNSUPPORTED_CONDITION_SCRIPT",
            { txid },
        );
    }

    return null;
}

function verifyExternalPreimageMap(
    node: DAGNode,
    witnessPreimages?: Map<string, Uint8Array>,
): void {
    if (!witnessPreimages || witnessPreimages.size === 0) return;
    const input = node.tx.getInput(0);
    if (!input.tapLeafScript) return;

    for (const leaf of input.tapLeafScript) {
        const [_cb, scriptWithVersion] = leaf;
        if (!scriptWithVersion || scriptWithVersion.length < 2) continue;

        let decoded: (string | number | bigint | Uint8Array)[];
        try {
            decoded = Script.decode(scriptWithVersion.slice(0, -1));
        } catch {
            continue;
        }

        for (const condition of extractHashConditions(decoded)) {
            const hashHex = hex.encode(condition.expectedHash);
            if (!witnessPreimages.has(hashHex)) continue;

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
                    },
                );
            }
        }
    }
}

/**
 * Resolved, verified sovereign conditional spend ready for witness assembly.
 */
export interface VerifiedSovereignCondition {
    /** The single unambiguously matched tapLeafScript entry `[controlBlock, scriptWithVersion]`. */
    leaf: NonNullable<ReturnType<Transaction["getInput"]>["tapLeafScript"]>[number];
    /** Raw tapscript bytes (without trailing leaf version byte). */
    script: Uint8Array;
    /** Decoded tapscript elements. */
    decoded: (string | number | bigint | Uint8Array)[];
    /** The single verified `ConditionWitness` preimage bytes (<= 80 bytes, hash-matched). */
    preimage: Uint8Array;
    /** The parsed allowlisted hash condition from the spent leaf. */
    hashCondition: HashCondition;
    /** Optional `OP_SIZE <N>` requirement from the spent leaf (e.g. 32 for VHTLC v2). */
    expectedPreimageSize?: number;
}

/**
 * Validates and resolves the exact spent conditional tapleaf and PSBT `ConditionWitness`
 * for a single-input sovereign virtual transaction, failing closed on any ambiguity,
 * unsupported condition script, oversized witness item, or missing/wrong preimage.
 *
 * Returns `null` for valid non-conditional spends (key-path spends or unconditional
 * script-path leaves carrying no `ConditionWitness`).
 */
export function resolveVerifiedSovereignCondition(
    tx: Transaction,
    txid: string,
): VerifiedSovereignCondition | null {
    if (tx.inputsLength !== 1) {
        throw new VtxoVerificationError(
            `Sovereign verification expects a single-input virtual transaction (got ${tx.inputsLength}) in tx ${txid}`,
            "INVALID_CONDITION_WITNESS",
            { txid, inputsLength: tx.inputsLength },
        );
    }

    const input = tx.getInput(0);

    // Reject pre-finalized witness/scriptSig fields: finalizers preserve an existing
    // finalScriptWitness verbatim, which would bypass the verified PSBT signing/condition fields.
    if (input.finalScriptWitness !== undefined || input.finalScriptSig !== undefined) {
        throw new VtxoVerificationError(
            `Transaction ${txid} must not carry pre-populated finalScriptWitness/finalScriptSig`,
            "INVALID_CONDITION_WITNESS",
            { txid },
        );
    }

    const conditionFields = getArkPsbtFields(tx, 0, ConditionWitness);

    if (conditionFields.length > 1) {
        throw new VtxoVerificationError(
            `Transaction ${txid} carries multiple ConditionWitness fields on input 0`,
            "INVALID_CONDITION_WITNESS",
            { txid, count: conditionFields.length },
        );
    }

    const conditionWitness = conditionFields[0];

    // Key-path spends execute no tapscript; reject stray ConditionWitness.
    if (input.tapKeySig) {
        if (conditionWitness !== undefined) {
            throw new VtxoVerificationError(
                `Transaction ${txid} carries ConditionWitness on a key-path spend`,
                "INVALID_CONDITION_WITNESS",
                { txid },
            );
        }
        return null;
    }

    // Script-path spend: resolve the single unambiguously signed spent leaf and verify ConditionWitness.
    const scriptSigs = input.tapScriptSig;
    if (scriptSigs && scriptSigs.length > 0) {
        const leaves = input.tapLeafScript ?? [];
        const uniqueLeafHashes = new Set(scriptSigs.map(([{ leafHash }]) => hex.encode(leafHash)));
        if (uniqueLeafHashes.size !== 1) {
            throw new VtxoVerificationError(
                `Transaction ${txid} carries tapScriptSig entries for ${uniqueLeafHashes.size} distinct tapleaves`,
                "INVALID_CONDITION_WITNESS",
                { txid, leafCount: uniqueLeafHashes.size },
            );
        }

        const targetLeafHash = scriptSigs[0][0].leafHash;
        const matchingLeaves = leaves.filter((candidate) => {
            const scriptWithVer = candidate[1];
            if (!scriptWithVer || scriptWithVer.length < 2) return false;
            const leafVersion = scriptWithVer[scriptWithVer.length - 1];
            const scriptBytes = scriptWithVer.slice(0, -1);
            return equalBytes(tapLeafHash(scriptBytes, leafVersion), targetLeafHash);
        });

        if (matchingLeaves.length === 0) {
            throw new VtxoVerificationError(
                `No matching tapLeafScript found for spent leaf in transaction ${txid}`,
                "INVALID_SIGNATURE",
                { txid, leafHash: hex.encode(targetLeafHash) },
            );
        }
        if (matchingLeaves.length > 1) {
            throw new VtxoVerificationError(
                `Transaction ${txid} carries ${matchingLeaves.length} ambiguous tapLeafScript entries for spent leaf`,
                "INVALID_CONDITION_WITNESS",
                { txid, leafHash: hex.encode(targetLeafHash), matchCount: matchingLeaves.length },
            );
        }

        const spentLeaf = matchingLeaves[0];
        const spentScriptBytes = spentLeaf[1].slice(0, -1);
        let decoded: (string | number | bigint | Uint8Array)[];
        try {
            decoded = Script.decode(spentScriptBytes);
        } catch {
            throw new VtxoVerificationError(
                `Failed to decode spent tapleaf script in transaction ${txid}`,
                "INVALID_ARK_SCRIPT",
                { txid },
            );
        }

        const parsedCondition = parseSpentLeafCondition(decoded, txid);

        if (parsedCondition === null) {
            if (conditionWitness !== undefined) {
                throw new VtxoVerificationError(
                    `Transaction ${txid} carries unexpected ConditionWitness for an unconditional tapleaf`,
                    "INVALID_CONDITION_WITNESS",
                    { txid, itemCount: conditionWitness.length },
                );
            }
            return null;
        }

        if (!conditionWitness || conditionWitness.length === 0) {
            throw new VtxoVerificationError(
                `Transaction ${txid} spends a conditional tapleaf but is missing ConditionWitness in the PSBT`,
                "MISSING_CONDITION_WITNESS",
                {
                    txid,
                    opcode: parsedCondition.hashCondition.opcode,
                    expectedHash: hex.encode(parsedCondition.hashCondition.expectedHash),
                },
            );
        }

        if (conditionWitness.length !== 1) {
            throw new VtxoVerificationError(
                `Transaction ${txid} ConditionWitness has ${conditionWitness.length} items, expected 1 preimage`,
                "INVALID_CONDITION_WITNESS",
                { txid, itemCount: conditionWitness.length },
            );
        }

        const witnessPreimage = conditionWitness[0];
        if (witnessPreimage.length > MAX_TAPSCRIPT_CONSENSUS_WITNESS_ITEM_SIZE) {
            throw new VtxoVerificationError(
                `ConditionWitness preimage length ${witnessPreimage.length} exceeds BIP-342 tapscript consensus stack item limit (${MAX_TAPSCRIPT_CONSENSUS_WITNESS_ITEM_SIZE} bytes) in tx ${txid}`,
                "INVALID_CONDITION_WITNESS",
                {
                    txid,
                    actualSize: witnessPreimage.length,
                    maxStandardSize: MAX_STANDARD_TAPSCRIPT_WITNESS_ITEM_SIZE,
                    maxConsensusSize: MAX_TAPSCRIPT_CONSENSUS_WITNESS_ITEM_SIZE,
                    limit: "consensus",
                },
            );
        }
        if (witnessPreimage.length > MAX_STANDARD_TAPSCRIPT_WITNESS_ITEM_SIZE) {
            throw new VtxoVerificationError(
                `ConditionWitness preimage length ${witnessPreimage.length} exceeds standard Bitcoin Core tapscript relay policy limit (${MAX_STANDARD_TAPSCRIPT_WITNESS_ITEM_SIZE} bytes) in tx ${txid}`,
                "INVALID_CONDITION_WITNESS",
                {
                    txid,
                    actualSize: witnessPreimage.length,
                    maxStandardSize: MAX_STANDARD_TAPSCRIPT_WITNESS_ITEM_SIZE,
                    maxConsensusSize: MAX_TAPSCRIPT_CONSENSUS_WITNESS_ITEM_SIZE,
                    limit: "relay_policy",
                },
            );
        }
        if (
            parsedCondition.expectedPreimageSize !== undefined &&
            witnessPreimage.length !== parsedCondition.expectedPreimageSize
        ) {
            throw new VtxoVerificationError(
                `ConditionWitness preimage length ${witnessPreimage.length} does not satisfy OP_SIZE ${parsedCondition.expectedPreimageSize} in tx ${txid}`,
                "INVALID_HASH_PREIMAGE",
                {
                    txid,
                    actualSize: witnessPreimage.length,
                    expectedSize: parsedCondition.expectedPreimageSize,
                },
            );
        }

        const result = verifyPreimage(witnessPreimage, parsedCondition.hashCondition);
        if (!result.valid) {
            throw new VtxoVerificationError(
                `ConditionWitness hash preimage verification failed for ${parsedCondition.hashCondition.opcode} in tx ${txid}`,
                "INVALID_HASH_PREIMAGE",
                {
                    txid,
                    opcode: parsedCondition.hashCondition.opcode,
                    computedHash: result.computedHash,
                    expectedHash: result.expectedHash,
                },
            );
        }

        return {
            leaf: spentLeaf,
            script: spentScriptBytes,
            decoded,
            preimage: witnessPreimage,
            hashCondition: parsedCondition.hashCondition,
            expectedPreimageSize: parsedCondition.expectedPreimageSize,
        };
    }

    if (conditionWitness !== undefined) {
        throw new VtxoVerificationError(
            `Transaction ${txid} carries ConditionWitness without a signed script-path spend`,
            "INVALID_CONDITION_WITNESS",
            { txid, itemCount: conditionWitness.length },
        );
    }

    return null;
}

/**
 * Verifies the actual PSBT `ConditionWitness` that sovereign exit finalization will serialize
 * against the exact spent tapleaf script, failing closed on missing, wrong, mismatched-size,
 * oversized, unexpected, or unsupported conditions.
 *
 * Sovereign claim length policy:
 * - Enforces both BIP-342 consensus (`<= 520` bytes) and Bitcoin Core standard Tapscript
 *   relay policy (`<= 80` bytes) on the `ConditionWitness` preimage before persistence so
 *   legacy `VHTLC.Script` (v1) claims without `OP_SIZE` cannot persist unbroadcastable
 *   (`bad-witness-nonstandard`) or consensus-invalid witnesses.
 * - Enforces exact `OP_SIZE` length when present in the spent leaf (e.g. 32 bytes for
 *   `VHTLC.ScriptV2`), while accepting valid legacy `VHTLC.Script` (v1) claims up to 80 bytes.
 *
 * For script-path spends (`tapScriptSig` present), a good external `witnessPreimages` map
 * can NEVER override a missing, oversized, or wrong `ConditionWitness` in the PSBT.
 *
 * @param node  The DAG node to verify.
 * @param witnessPreimages  Optional map of (expected hash hex → preimage bytes)
 *                          validated additionally when provided.
 * @throws VtxoVerificationError on missing/invalid/oversized `ConditionWitness`, failed
 *         hash/size condition, or unsupported condition script.
 */
export function verifyNodeHashPreimages(
    node: DAGNode,
    witnessPreimages?: Map<string, Uint8Array>,
): void {
    resolveVerifiedSovereignCondition(node.tx, node.txid);
    verifyExternalPreimageMap(node, witnessPreimages);
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
    witnessPreimages?: Map<string, Uint8Array>,
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
