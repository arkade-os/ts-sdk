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
import {
    taprootTweakPubkey,
    tagSchnorr,
    compareBytes,
    equalBytes,
} from "@scure/btc-signer/utils.js";
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
        try {
            controlBlock = hex.decode(cb);
        } catch {
            throw new VtxoVerificationError(
                `Invalid control block format in ${txid}`,
                "INVALID_MERKLE_PROOF",
            );
        }
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

/**
 * Helper to validate BIP 342 Tapscript 2-of-2 (or N-of-N) CHECKSIGVERIFY template:
 *   <pk1> CHECKSIGVERIFY <pk2> CHECKSIGVERIFY ... <pkn> CHECKSIG
 * Requires:
 *   - Alternating 32/33-byte public keys and CHECKSIGVERIFY, ending with CHECKSIG.
 *   - At least 2 distinct public keys.
 */
function isCheckSigVerifyMultisigTemplate(
    decoded: (string | number | bigint | Uint8Array)[],
): boolean {
    if (decoded.length < 4 || decoded.length % 2 !== 0) return false;
    const numKeys = decoded.length / 2;
    const keys = new Set<string>();

    for (let i = 0; i < numKeys; i++) {
        const keyItem = decoded[2 * i];
        const opItem = decoded[2 * i + 1];

        if (!(keyItem instanceof Uint8Array) || (keyItem.length !== 32 && keyItem.length !== 33)) {
            return false;
        }
        keys.add(hex.encode(keyItem));

        if (i < numKeys - 1) {
            if (opItem !== "CHECKSIGVERIFY") return false;
        } else {
            if (opItem !== "CHECKSIG") return false;
        }
    }

    return keys.size >= 2;
}

/**
 * Helper to validate BIP 342 Tapscript 2-of-2 (or N-of-N) CHECKSIGADD template:
 *   <pk1> CHECKSIG <pk2> CHECKSIGADD ... <pkn> CHECKSIGADD <N> [NUM]EQUAL
 *   or <pk1> CHECKSIGADD <pk2> CHECKSIGADD ... <pkn> CHECKSIGADD <N> [NUM]EQUAL
 * Requires:
 *   - Key pushes followed by CHECKSIG/CHECKSIGADD.
 *   - Ending with threshold <N> and EQUAL / NUMEQUAL where N === number of keys.
 *   - At least 2 distinct public keys.
 *
 * Note on N-of-N constraint (Finding N1):
 *   This template matcher intentionally enforces strict N-of-N (threshold === numKeys)
 *   matching current Ark collaborative leaves (e.g. 2-of-2 ASP + user). M-of-N thresholds
 *   where threshold < numKeys are not currently used in Ark collaborative paths and are
 *   conservatively rejected.
 */
function isCheckSigAddMultisigTemplate(
    decoded: (string | number | bigint | Uint8Array)[],
): boolean {
    if (decoded.length < 6) return false;
    const lastOp = decoded[decoded.length - 1];
    if (lastOp !== "NUMEQUAL" && lastOp !== "EQUAL") return false;

    const thresholdRaw = decoded[decoded.length - 2];
    const threshold =
        typeof thresholdRaw === "bigint"
            ? Number(thresholdRaw)
            : typeof thresholdRaw === "number"
              ? thresholdRaw
              : null;

    const sigOps = decoded.slice(0, decoded.length - 2);
    if (sigOps.length < 4 || sigOps.length % 2 !== 0) return false;
    const numKeys = sigOps.length / 2;

    if (threshold === null || threshold !== numKeys) return false;

    const keys = new Set<string>();
    for (let i = 0; i < numKeys; i++) {
        const keyItem = sigOps[2 * i];
        const opItem = sigOps[2 * i + 1];

        if (!(keyItem instanceof Uint8Array) || (keyItem.length !== 32 && keyItem.length !== 33)) {
            return false;
        }
        keys.add(hex.encode(keyItem));

        if (i === 0) {
            if (opItem !== "CHECKSIG" && opItem !== "CHECKSIGADD") return false;
        } else {
            if (opItem !== "CHECKSIGADD") return false;
        }
    }

    return keys.size >= 2;
}

/**
 * Validates whether a script matches an allowlisted collaborative / forfeit multisig template.
 * Supported templates:
 * 1. BIP 342 CHECKSIGVERIFY chain (<pk1> CHECKSIGVERIFY <pk2> CHECKSIG) with >= 2 distinct keys.
 * 2. BIP 342 CHECKSIGADD chain (<pk1> CHECKSIG <pk2> CHECKSIGADD 2 EQUAL/NUMEQUAL) with >= 2 distinct keys.
 * 3. Conditional Multisig (<condition> VERIFY <multisig_template>) with >= 2 distinct keys.
 *
 * Note on Conditional Multisig (Finding N2):
 *   Uses lastIndexOf("VERIFY") to locate the terminal multisig template. Because compound opcodes
 *   (e.g., EQUALVERIFY, CHECKSEQUENCEVERIFY) decode as distinct tokens from standalone VERIFY,
 *   this reliably isolates preceding validation conditions (such as hashlocks or CLTV) without
 *   ambiguity for standard Ark and forfeit script formats.
 */
function isCollaborativeMultisigTemplate(
    decoded: (string | number | bigint | Uint8Array)[],
): boolean {
    if (isCheckSigVerifyMultisigTemplate(decoded) || isCheckSigAddMultisigTemplate(decoded)) {
        return true;
    }

    // Check for conditional multisig: <condition...> VERIFY <multisig>
    const verifyIdx = decoded.lastIndexOf("VERIFY");
    if (verifyIdx !== -1 && verifyIdx < decoded.length - 1) {
        const suffix = decoded.slice(verifyIdx + 1);
        if (isCheckSigVerifyMultisigTemplate(suffix) || isCheckSigAddMultisigTemplate(suffix)) {
            return true;
        }
    }

    return false;
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
    const keys = decoded.filter(
        (item): item is Uint8Array =>
            item instanceof Uint8Array && (item.length === 32 || item.length === 33),
    );
    const hasKey = keys.length > 0;

    // ── Standard Ark Exit Policy & Submarine Swap HTLC Policies ──
    const hasCSV = decoded.some((op) => op === "CHECKSEQUENCEVERIFY");
    const hasCLTV = decoded.some((op) => op === "CHECKLOCKTIMEVERIFY");
    const checkSigOps = decoded.filter(
        (op) => op === "CHECKSIG" || op === "CHECKSIGVERIFY" || op === "CHECKSIGADD",
    );
    const hasCheckSig = checkSigOps.length > 0;
    const hasHash = decoded.some(
        (op) => op === "SHA256" || op === "HASH160" || op === "RIPEMD160" || op === "HASH256",
    );

    const isArkStandard = hasCSV && hasCheckSig && hasKey;
    const isSwapClaim = hasHash && hasCheckSig && hasKey;
    const isSwapRefund = (hasCLTV || hasCSV) && hasCheckSig && hasKey;

    // Collaborative / forfeit multisig:
    // Note (Protocol Invariant): Forfeit scripts and collaborative leaves intentionally carry no CSV timelock.
    // In the Ark protocol, collaborative spends and forfeit clauses require 2-of-2 co-signing by both the
    // user and the ASP (mutual consent), enabling instant off-chain transitions and immediate forfeit sweeps
    // upon settlement without requiring an on-chain delay.
    //
    // Security Invariant (Finding C / Finding 11 - Template Matching):
    // Rather than loose opcode counting (which could be bypassed by decorative keys or vacuous CHECKSIG+DROP sequences),
    // collaborative leaves must strictly match explicit allowlisted BIP 342 multisig templates:
    //   - <pk1> CHECKSIGVERIFY <pk2> CHECKSIG (BIP 342 2-of-2 CHECKSIGVERIFY chain)
    //   - <pk1> CHECKSIG <pk2> CHECKSIGADD 2 NUMEQUAL/EQUAL (BIP 342 2-of-2 CHECKSIGADD)
    //   - Conditional multisig: <condition> VERIFY <multisig_template>
    // In all cases, at least 2 distinct public keys must participate in active signature enforcement.
    const isCollaborativeMultisig = isCollaborativeMultisigTemplate(decoded);

    if (!isArkStandard && !isSwapClaim && !isSwapRefund && !isCollaborativeMultisig) {
        throw new VtxoVerificationError(
            `Tapleaf script in ${txid} does not follow Ark exit policy (CSV+CHECKSIG), Swap policy (HTLC), or Collaborative Multisig template (>=2 distinct keys in standard 2-of-2 format)`,
            "INVALID_ARK_SCRIPT",
        );
    }
}
