/**
 * ============================================================================
 *  VTXO Signature Verification — Tier 1: Schnorr & MuSig2 Validation
 * ============================================================================
 *
 *  Implements cryptographic verification of virtual transaction signatures.
 *
 *  Ark virtual transactions use Taproot (BIP 341/342).
 *  MuSig2 results in a standard Schnorr signature (BIP 340).
 *
 *  This module:
 *    1. Recursively traverses the reconstructed VTXO DAG.
 *    2. For each transaction, calculates the correct Taproot sighash (BIP 341).
 *    3. Verifies the signature (tapKeySig) against the aggregated internal key.
 *    4. Fails loudly on any invalid or missing signature.
 *
 *  Dependencies: @noble/curves/secp256k1, @scure/btc-signer
 * ============================================================================
 */

import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { type DAGNode, VtxoVerificationError } from "./vtxoDAGVerification.js";
import { taprootTweakPubkey, equalBytes } from "@scure/btc-signer/utils.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";

// SIGHASH_DEFAULT (0x00) is the standard for Taproot key-path spends in Ark
const SIGHASH_DEFAULT = 0x00;

/**
 * Recursively verifies signatures for the entire DAG.
 *
 * @param node  The current node in the DAG to verify.
 * @throws VtxoVerificationError if any signature is invalid or missing.
 */
export function verifyDAGSignatures(node: DAGNode): void {
    const stack: DAGNode[] = [node];
    while (stack.length > 0) {
        const current = stack.pop()!;
        // 1. Verify signatures for the current node's input
        verifyNodeSignature(current);

        // 2. Add children to stack for iterative processing
        for (const child of current.children.values()) {
            stack.push(child);
        }
    }
}

/**
 * Verifies the signature of a single DAG node (virtual transaction).
 * Most Ark virtual transactions are single-input Taproot keypath spends.
 */
export function verifyNodeSignature(node: DAGNode): void {
    const { tx, txid } = node;

    // Virtual transactions must have exactly 1 input by protocol design
    const input = tx.getInput(0);

    // ── Step 1: Handle Taproot Key Path Spend (tapKeySig) ───────────────────
    //
    // In Ark, virtual transactions are usually signed by an aggregated key
    // (ASP + User) using MuSig2, which results in a standard 64-byte
    // Schnorr signature stored in tapKeySig.
    //
    const tapKeySig = input.tapKeySig;
    const tapInternalKey = input.tapInternalKey;

    if (!tapKeySig) {
        // If no key-sig, check if it's a script-path spend (not typical for VTXOs)
        if (input.tapScriptSig && input.tapScriptSig.length > 0) {
            return verifyNodeScriptPathSignature(node);
        }
        throw new VtxoVerificationError(
            `Transaction ${txid} is missing a signature (tapKeySig)`,
            "MISSING_SIGNATURE",
            { txid },
        );
    }

    if (!tapInternalKey) {
        throw new VtxoVerificationError(
            `Transaction ${txid} is missing the internal public key (tapInternalKey)`,
            "MISSING_INTERNAL_KEY",
            { txid },
        );
    }

    // ── Step 2: Extract sighash type ───────────────────────────────────────
    //
    // If tapKeySig is 65 bytes, the last byte is the sighash type.
    // If it's 64 bytes, it's SIGHASH_DEFAULT (0x00).
    //
    let signature = tapKeySig;
    let sighashType = SIGHASH_DEFAULT;

    if (tapKeySig.length === 65) {
        signature = tapKeySig.slice(0, 64);
        sighashType = tapKeySig[64];

        // Strict Compliance: Reject any sighash that is not SIGHASH_ALL (0x01)
        // if a byte is explicitly provided.
        if (sighashType !== 0x01) {
            throw new VtxoVerificationError(
                `Transaction ${txid} uses an unsupported sighash flag: 0x${sighashType.toString(16)}`,
                "UNSUPPORTED_SIGHASH",
                { txid, sighashType },
            );
        }
    } else if (tapKeySig.length !== 64) {
        throw new VtxoVerificationError(
            `Transaction ${txid} has an invalid signature length (${tapKeySig.length})`,
            "INVALID_SIGNATURE_LENGTH",
            { txid, length: tapKeySig.length },
        );
    }
    // If length is 64, sighashType is implicitly SIGHASH_DEFAULT (0x00), which is allowed.

    // ── Step 3: Compute the Taproot Sighash (BIP 341) ──────────────────────
    //
    // We need to provide ALL previous outputs (scripts and amounts) to
    // compute the sighash for any Taproot input.
    //
    const prevOuts = getPrevOutsForNode(node);
    const prevScripts = prevOuts.map((o) => o.script);
    const prevAmounts = prevOuts.map((o) => o.amount);

    // Using the public preimageWitnessV1 method from btc-signer
    const sighash = tx.preimageWitnessV1(
        0, // input index
        prevScripts,
        sighashType,
        prevAmounts,
    );

    // ── Step 4: Verify the Schnorr Signature ───────────────────────────────
    //
    // ZERO TRUST: Independent verification against the TWEAKED public key.
    // BIP 341: Q = P + tweak(P, merkle_root)
    //
    const merkleRoot = input.tapMerkleRoot || new Uint8Array(0);
    const [tweakedKey] = taprootTweakPubkey(tapInternalKey, merkleRoot);

    const isValid = schnorr.verify(signature, sighash, tweakedKey);

    if (!isValid) {
        throw new VtxoVerificationError(
            `Invalid signature for transaction ${txid}`,
            "INVALID_SIGNATURE",
            {
                txid,
                sighashType,
                internalKey: hex.encode(tapInternalKey),
                tweakedKey: hex.encode(tweakedKey),
            },
        );
    }
}

/**
 * Verifies script-path signatures if present (BIP 342).
 */
function verifyNodeScriptPathSignature(node: DAGNode): void {
    const { tx, txid } = node;
    const input = tx.getInput(0);
    const prevOuts = getPrevOutsForNode(node);
    const prevScripts = prevOuts.map((o) => o.script);
    const prevAmounts = prevOuts.map((o) => o.amount);

    const tapScriptSig = input.tapScriptSig;
    if (!tapScriptSig || tapScriptSig.length === 0) {
        return;
    }

    const tapLeafScript = input.tapLeafScript || [];

    for (const [keyInfo, sig] of tapScriptSig) {
        const pubkey = keyInfo.pubKey;
        const leafHash = keyInfo.leafHash;

        // Find the corresponding tapLeafScript
        let matchingScript: Uint8Array | undefined;
        let leafVer = 0xc0;

        for (const leaf of tapLeafScript) {
            const scriptWithVer = leaf[1];
            if (scriptWithVer && scriptWithVer.length > 0) {
                const script = scriptWithVer.slice(0, -1);
                const ver = scriptWithVer[scriptWithVer.length - 1];
                const hash = tapLeafHash(script, ver);
                if (equalBytes(hash, leafHash)) {
                    matchingScript = script;
                    leafVer = ver;
                    break;
                }
            }
        }

        if (!matchingScript) {
            throw new VtxoVerificationError(
                `No matching tapLeafScript found for script-path signature in transaction ${txid}`,
                "INVALID_SIGNATURE",
                { txid, leafHash: hex.encode(leafHash) },
            );
        }

        let signature = sig;
        let sighashType = SIGHASH_DEFAULT;

        if (sig.length === 65) {
            signature = sig.slice(0, 64);
            sighashType = sig[64];

            if (sighashType !== 0x01) {
                throw new VtxoVerificationError(
                    `Transaction ${txid} script-path signature uses an unsupported sighash flag: 0x${sighashType.toString(16)}`,
                    "UNSUPPORTED_SIGHASH",
                    { txid, sighashType },
                );
            }
        } else if (sig.length !== 64) {
            throw new VtxoVerificationError(
                `Transaction ${txid} script-path signature has an invalid length (${sig.length})`,
                "INVALID_SIGNATURE_LENGTH",
                { txid, length: sig.length },
            );
        }

        const sighash = tx.preimageWitnessV1(
            0,
            prevScripts,
            sighashType,
            prevAmounts,
            undefined,
            matchingScript,
            leafVer,
        );

        const isValid = schnorr.verify(signature, sighash, pubkey);
        if (!isValid) {
            throw new VtxoVerificationError(
                `Invalid script-path signature in transaction ${txid}`,
                "INVALID_SIGNATURE",
                { txid },
            );
        }
    }
}

/**
 * Collects the previous output information needed for sighash calculation.
 * For virtual transactions in the DAG, the ancestor's outputs are used.
 */
function getPrevOutsForNode(node: DAGNode): { script: Uint8Array; amount: bigint }[] {
    // Every transaction in the VTXO DAG has exactly 1 input spending from its ancestor.

    if (!node.ancestor) {
        // This is the anchoring node spending from the commitment transaction.
        // The context was injected by reconstructAndValidateVtxoDAG.
        const context = node.prevOutContext;
        if (!context) {
            throw new Error(
                "Commitment output context missing for anchoring node signature verification",
            );
        }
        return [context];
    }

    // Normal tree/ark tx: spending from the ancestor DAGNode
    const ancestorNode = node.ancestor;
    const ancestorOutput = ancestorNode.tx.getOutput(node.ancestorOutputIndex ?? 0);

    if (!ancestorOutput.script || ancestorOutput.amount === undefined) {
        throw new Error("Ancestor output info missing for sighash calculation");
    }

    return [
        {
            script: ancestorOutput.script,
            amount: ancestorOutput.amount,
        },
    ];
}
