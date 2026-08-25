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
import { Script } from "@scure/btc-signer/script.js";
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
            `Transaction ${node.txid} is missing tapInternalKey (BIP 341 violation)`,
            "MISSING_TAPROOT_METADATA",
        );
    }

    // 1. Verify Tweaked Pubkey Consistency
    if (witnessUtxo && witnessUtxo.script) {
        const rootBytes = merkleRoot || new Uint8Array(0);
        const [tweakedKey] = taprootTweakPubkey(internalKey, rootBytes);
        const expectedScript = new Uint8Array([0x51, 0x20, ...tweakedKey]);

        if (!equalBytes(witnessUtxo.script, expectedScript)) {
            throw new VtxoVerificationError(
                `Invalid Taproot Tweak for transaction ${node.txid}`,
                "INVALID_TAPROOT_TWEAK",
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
            verifyMerkleProof(merkleRoot, script, cb, node.txid, leafVersion);

            // 2b. Enforce Ark Exit Policy
            verifyArkExitPolicy(script, node.txid);
        }
    }
}

function verifyMerkleProof(
    merkleRoot: Uint8Array,
    script: Uint8Array,
    cb: any,
    txid: string,
    providedVersion: number = 0xc0,
): void {
    let controlBlock: Uint8Array;
    if (cb instanceof Uint8Array) {
        controlBlock = cb;
    } else if (cb && typeof cb === "object" && cb.internalKey && cb.merklePath) {
        // It's a decoded control block object from btc-signer psbt.js
        const leafVersion = (cb.leafVersion ?? providedVersion) & 0xfe;
        const leafHash = tapLeafHash(script, leafVersion);

        let currentHash = leafHash;
        for (const branch of cb.merklePath) {
            currentHash = tapBranchHash(currentHash, branch);
        }

        if (!equalBytes(currentHash, merkleRoot)) {
            throw new VtxoVerificationError(
                `Merkle proof failure in transaction ${txid}`,
                "INVALID_MERKLE_PROOF",
            );
        }
        return;
    } else if (typeof cb === "string") {
        controlBlock = hex.decode(cb);
    } else {
        throw new VtxoVerificationError(
            `Invalid control block format in ${txid}`,
            "INVALID_MERKLE_PROOF",
        );
    }

    if (controlBlock.length < 33) {
        throw new VtxoVerificationError(
            `Invalid control block length in ${txid}`,
            "INVALID_MERKLE_PROOF",
        );
    }

    const leafVersion = controlBlock[0] & 0xfe;
    const leafHash = tapLeafHash(script, leafVersion);

    let currentHash = leafHash;
    const numSteps = (controlBlock.length - 33) / 32;

    if (numSteps < 0 || !Number.isInteger(numSteps)) {
        throw new VtxoVerificationError(
            `Invalid control block length in ${txid}`,
            "INVALID_MERKLE_PROOF",
        );
    }

    for (let i = 0; i < numSteps; i++) {
        const branch = controlBlock.slice(33 + i * 32, 33 + (i + 1) * 32);
        currentHash = tapBranchHash(currentHash, branch);
    }

    if (!equalBytes(currentHash, merkleRoot)) {
        throw new VtxoVerificationError(
            `Merkle proof failure in transaction ${txid}`,
            "INVALID_MERKLE_PROOF",
        );
    }
}

function verifyArkExitPolicy(script: Uint8Array, txid: string): void {
    if (!script || script.length === 0) {
        throw new VtxoVerificationError(`Empty tapleaf script in ${txid}`, "SECURITY_VIOLATION");
    }

    let decoded: (string | number | bigint | Uint8Array)[];
    try {
        decoded = Script.decode(script);
    } catch (e) {
        throw new VtxoVerificationError(
            `Failed to decode tapleaf script in ${txid}`,
            "INVALID_ARK_SCRIPT",
        );
    }

    // 1. Structural Liveness - Ensure there are no trivial scripts (e.g. OP_TRUE, OP_1, OP_NOP)
    if (
        decoded.length === 0 ||
        (decoded.length === 1 &&
            (decoded[0] === 1 ||
                decoded[0] === 1n ||
                decoded[0] === "TRUE" ||
                decoded[0] === "NOP" ||
                (decoded[0] instanceof Uint8Array && decoded[0].length === 0)))
    ) {
        throw new VtxoVerificationError(
            `Forbidden trivial script in ${txid}`,
            "SECURITY_VIOLATION",
        );
    }

    // ── Key Presence Verification ──
    const hasKey = decoded.some(
        (item) => item instanceof Uint8Array && (item.length === 32 || item.length === 33),
    );

    // ── Standard Ark Exit Policy & Collaborative Leaves ──
    const hasCSV = decoded.some((op) => op === "CHECKSEQUENCEVERIFY");
    const hasCheckSig = decoded.some((op) => op === "CHECKSIG" || op === "CHECKSIGVERIFY");

    // ── Submarine Swap HTLC Policies ──
    const hasHash = decoded.some(
        (op) => op === "HASH160" || op === "SHA256" || op === "HASH256" || op === "RIPEMD160",
    );
    const hasCLTV = decoded.some((op) => op === "CHECKLOCKTIMEVERIFY");

    const isArkStandard = hasCSV && hasCheckSig && hasKey;
    const isSwapClaim = hasHash && hasCheckSig && hasKey;
    const isSwapRefund = hasCLTV && hasCheckSig && hasKey;
    const isCollaborativeMultisig = hasCheckSig && hasKey;

    if (!isArkStandard && !isSwapClaim && !isSwapRefund && !isCollaborativeMultisig) {
        throw new VtxoVerificationError(
            `Tapleaf script in ${txid} does not follow Ark or HTLC exit policies`,
            "INVALID_ARK_SCRIPT",
        );
    }
}
