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

interface ParsedControlBlock {
    internalKey: Uint8Array;
    leafVersion: number;
    parity: number | null;
    merklePath: Uint8Array[];
}

function computeTaprootScriptAndParity(
    internalKey: Uint8Array,
    merkleRoot: Uint8Array,
    txid: string,
): { script: Uint8Array; parity: number } {
    if (internalKey.length !== 32) {
        throw new VtxoVerificationError(
            `Invalid Taproot internal key length (${internalKey.length}) in transaction ${txid}`,
            "INVALID_TAPROOT_TWEAK",
        );
    }
    try {
        const [tweakedKey, parity] = taprootTweakPubkey(internalKey, merkleRoot);
        return {
            script: new Uint8Array([0x51, 0x20, ...tweakedKey]),
            parity,
        };
    } catch {
        throw new VtxoVerificationError(
            `Invalid Taproot Tweak for transaction ${txid}`,
            "INVALID_TAPROOT_TWEAK",
        );
    }
}

/**
 * Verifies the Taproot configuration for a DAG node.
 *
 * Supports both:
 *   - Key-path spends (e.g. TREE MuSig2 transactions carrying `tapInternalKey` and `tapKeySig`).
 *   - Script-path spends (e.g. ARK / CHECKPOINT transactions produced by the SDK and arkd v0.9.25,
 *     which omit optional `tapInternalKey` / `tapMerkleRoot` and authenticate against the prevout
 *     script via each `tapLeafScript` control block's internal key, Merkle path, and parity bit).
 */
export function verifyNodeTaproot(node: DAGNode): void {
    const input = node.tx.getInput(0);
    const internalKey = input.tapInternalKey;
    const merkleRoot = input.tapMerkleRoot;
    const tapLeafScript = input.tapLeafScript;
    const hasLeafScripts = Array.isArray(tapLeafScript) && tapLeafScript.length > 0;

    if (input.tapScriptSig && input.tapScriptSig.length > 0 && !hasLeafScripts) {
        throw new VtxoVerificationError(
            `Transaction ${node.txid} has script-path signatures but is missing tapLeafScript (BIP 341 violation)`,
            "MISSING_TAPROOT_METADATA",
        );
    }

    if (!internalKey && !hasLeafScripts && !input.tapKeySig) {
        throw new VtxoVerificationError(
            `Transaction ${node.txid} is missing tapInternalKey and tapLeafScript (BIP 341 violation)`,
            "MISSING_TAPROOT_METADATA",
        );
    }

    // 1. Resolve prevout scriptPubKey to authenticate tweaked output key
    let expectedScript: Uint8Array | undefined;
    if (node.ancestor) {
        const ancestorOutput = node.ancestor.tx.getOutput(node.ancestorOutputIndex ?? 0);
        expectedScript = ancestorOutput.script;
    } else if (node.prevOutContext) {
        expectedScript = node.prevOutContext.script;
    }

    // Key-path spends from arkd (TREE nodes, v0.9.25 builder.go) carry only `tapKeySig`: the
    // internal key and merkle root are not in the PSBT. The signature is verified directly
    // against the prevout's P2TR output key (signatureVerification.ts), so here we only
    // require that the prevout actually is a taproot output.
    if (input.tapKeySig && !internalKey && !hasLeafScripts) {
        if (
            !expectedScript ||
            expectedScript.length !== 34 ||
            expectedScript[0] !== 0x51 ||
            expectedScript[1] !== 0x20
        ) {
            throw new VtxoVerificationError(
                `Key-path spend in transaction ${node.txid} does not spend a taproot (P2TR) output`,
                "INVALID_TAPROOT_TWEAK",
            );
        }
    }

    // 2. Verify key-path / explicit tapInternalKey tweak when present
    if (internalKey) {
        if (merkleRoot || !hasLeafScripts || input.tapKeySig) {
            const rootBytes = merkleRoot || new Uint8Array(0);
            const { script: computedScript } = computeTaprootScriptAndParity(
                internalKey,
                rootBytes,
                node.txid,
            );
            if (expectedScript && !equalBytes(expectedScript, computedScript)) {
                throw new VtxoVerificationError(
                    `Invalid Taproot Tweak for transaction ${node.txid}`,
                    "INVALID_TAPROOT_TWEAK",
                );
            }
        } else if (internalKey.length !== 32) {
            throw new VtxoVerificationError(
                `Invalid Taproot internal key length (${internalKey.length}) in transaction ${node.txid}`,
                "INVALID_TAPROOT_TWEAK",
            );
        }
    }

    // 3. Validate tapLeafScript control blocks, Merkle commitments, prevout tweak/parity, and Ark policy
    if (hasLeafScripts) {
        for (const leaf of tapLeafScript) {
            // leaf is [controlBlock, scriptWithVersion] based on PSBT spec and btc-signer
            const [cb, scriptWithVersion] = leaf;

            if (!cb || !(scriptWithVersion instanceof Uint8Array) || scriptWithVersion.length < 1) {
                throw new VtxoVerificationError(
                    `Malformed tapLeafScript entry in transaction ${node.txid}`,
                    "INVALID_MERKLE_PROOF",
                );
            }

            // PSBT v0/v2 spec: tapLeafScript value is <script> <leaf_version>
            const script = scriptWithVersion.slice(0, -1);
            const psbtLeafVersion = scriptWithVersion[scriptWithVersion.length - 1];
            if ((psbtLeafVersion & 1) !== 0) {
                throw new VtxoVerificationError(
                    `Invalid Tapscript leaf version 0x${psbtLeafVersion.toString(16)} in transaction ${node.txid}`,
                    "INVALID_MERKLE_PROOF",
                );
            }

            const parsedCb = parseControlBlock(cb, node.txid);
            if (parsedCb.leafVersion !== psbtLeafVersion) {
                throw new VtxoVerificationError(
                    `Control block leaf version 0x${parsedCb.leafVersion.toString(16)} does not match PSBT leaf version 0x${psbtLeafVersion.toString(16)} in transaction ${node.txid}`,
                    "INVALID_MERKLE_PROOF",
                );
            }

            // 3a. Compute Merkle root from leaf + control block path
            const computedMerkleRoot = computeMerkleRoot(
                script,
                parsedCb.leafVersion,
                parsedCb.merklePath,
            );

            if (merkleRoot && !equalBytes(computedMerkleRoot, merkleRoot)) {
                throw new VtxoVerificationError(
                    `Merkle proof failure in transaction ${node.txid}`,
                    "INVALID_MERKLE_PROOF",
                );
            }

            if (internalKey && !equalBytes(parsedCb.internalKey, internalKey)) {
                throw new VtxoVerificationError(
                    `Control block internal key does not match tapInternalKey in transaction ${node.txid}`,
                    "INVALID_TAPROOT_TWEAK",
                );
            }

            // 3b. Verify control block internalKey + computedMerkleRoot against prevout P2TR script and parity
            const { script: computedScript, parity } = computeTaprootScriptAndParity(
                parsedCb.internalKey,
                computedMerkleRoot,
                node.txid,
            );

            if (expectedScript) {
                if (!equalBytes(expectedScript, computedScript)) {
                    throw new VtxoVerificationError(
                        `Invalid Taproot Tweak for transaction ${node.txid}`,
                        "INVALID_TAPROOT_TWEAK",
                    );
                }
                if (parsedCb.parity !== null && parsedCb.parity !== parity) {
                    throw new VtxoVerificationError(
                        `Invalid Taproot control block parity bit in transaction ${node.txid}`,
                        "INVALID_MERKLE_PROOF",
                    );
                }
            }

            // 3c. Enforce Ark Exit Policy
            verifyArkExitPolicy(script, node.txid);
        }
    }
}

function parseControlBlock(cb: unknown, txid: string): ParsedControlBlock {
    if (cb instanceof Uint8Array || typeof cb === "string") {
        let controlBlock: Uint8Array;
        if (typeof cb === "string") {
            try {
                controlBlock = hex.decode(cb);
            } catch {
                throw new VtxoVerificationError(
                    `Invalid control block format in ${txid}`,
                    "INVALID_MERKLE_PROOF",
                );
            }
        } else {
            controlBlock = cb;
        }

        if (controlBlock.length < 33) {
            throw new VtxoVerificationError(
                `Invalid control block length in ${txid}`,
                "INVALID_MERKLE_PROOF",
            );
        }

        const numSteps = (controlBlock.length - 33) / 32;
        if (numSteps < 0 || !Number.isInteger(numSteps)) {
            throw new VtxoVerificationError(
                `Invalid control block length in ${txid}`,
                "INVALID_MERKLE_PROOF",
            );
        }

        if (numSteps > 128) {
            throw new VtxoVerificationError(
                `Taproot tree depth exceeds maximum allowed (128) in ${txid}`,
                "INVALID_MERKLE_PROOF",
            );
        }

        const versionByte = controlBlock[0];
        const merklePath: Uint8Array[] = [];
        for (let i = 0; i < numSteps; i++) {
            merklePath.push(controlBlock.slice(33 + i * 32, 33 + (i + 1) * 32));
        }

        return {
            internalKey: controlBlock.slice(1, 33),
            leafVersion: versionByte & 0xfe,
            parity: versionByte & 1,
            merklePath,
        };
    }

    if (cb && typeof cb === "object") {
        const obj = cb as {
            version?: unknown;
            leafVersion?: unknown;
            internalKey?: unknown;
            merklePath?: unknown;
        };

        if (!(obj.internalKey instanceof Uint8Array) || obj.internalKey.length !== 32) {
            throw new VtxoVerificationError(
                `Invalid control block internal key in ${txid}`,
                "INVALID_MERKLE_PROOF",
            );
        }
        if (!Array.isArray(obj.merklePath)) {
            throw new VtxoVerificationError(
                `Invalid control block merkle path in ${txid}`,
                "INVALID_MERKLE_PROOF",
            );
        }
        if (obj.merklePath.length > 128) {
            throw new VtxoVerificationError(
                `Taproot tree depth exceeds maximum allowed (128) in ${txid}`,
                "INVALID_MERKLE_PROOF",
            );
        }
        for (const branch of obj.merklePath) {
            if (!(branch instanceof Uint8Array) || branch.length !== 32) {
                throw new VtxoVerificationError(
                    `Invalid control block branch node in ${txid}`,
                    "INVALID_MERKLE_PROOF",
                );
            }
        }

        if (typeof obj.version === "number") {
            return {
                internalKey: obj.internalKey,
                leafVersion: obj.version & 0xfe,
                parity: obj.version & 1,
                merklePath: obj.merklePath as Uint8Array[],
            };
        }
        if (typeof obj.leafVersion === "number") {
            return {
                internalKey: obj.internalKey,
                leafVersion: obj.leafVersion & 0xfe,
                parity: null,
                merklePath: obj.merklePath as Uint8Array[],
            };
        }
    }

    throw new VtxoVerificationError(
        `Invalid control block format in ${txid}`,
        "INVALID_MERKLE_PROOF",
    );
}

function computeMerkleRoot(
    script: Uint8Array,
    leafVersion: number,
    merklePath: Uint8Array[],
): Uint8Array {
    let currentHash: Uint8Array = tapLeafHash(script, leafVersion);
    for (const branch of merklePath) {
        currentHash = tapBranchHash(currentHash, branch);
    }
    return currentHash;
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
 * Note on Conditional Multisig (Finding N2 / Finding F):
 *   Uses lastIndexOf("VERIFY") to locate the terminal multisig template. Coupled to
 *   @scure/btc-signer@2.4.1 Script.decode tokenization where compound opcodes
 *   ("EQUALVERIFY", "CHECKSIGVERIFY", "CHECKSEQUENCEVERIFY", "CHECKLOCKTIMEVERIFY")
 *   decode as distinct single tokens from standalone "VERIFY"; verify this token-distinctness
 *   invariant before upgrading @scure/btc-signer.
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

function isKey(item: any): item is Uint8Array {
    return item instanceof Uint8Array && (item.length === 32 || item.length === 33);
}

function isHashOpcode(op: any): boolean {
    return op === "SHA256" || op === "HASH160" || op === "RIPEMD160" || op === "HASH256";
}

/**
 * Validates whether a script matches the standard Ark unilateral exit template:
 * - <sequence> CHECKSEQUENCEVERIFY DROP <pubkey> CHECKSIG
 * - <sequence> CHECKSEQUENCEVERIFY DROP <multisig_template>
 * - <condition> VERIFY <sequence> CHECKSEQUENCEVERIFY DROP <pubkey> CHECKSIG / <multisig_template>
 */
function isArkStandardExitTemplate(decoded: (string | number | bigint | Uint8Array)[]): boolean {
    let ops = decoded;
    const verifyIdx = decoded.lastIndexOf("VERIFY");
    if (verifyIdx !== -1 && verifyIdx < decoded.length - 4) {
        ops = decoded.slice(verifyIdx + 1);
    }

    if (ops.length >= 5 && ops[1] === "CHECKSEQUENCEVERIFY" && ops[2] === "DROP") {
        const remaining = ops.slice(3);
        if (remaining.length === 2 && isKey(remaining[0]) && remaining[1] === "CHECKSIG") {
            return true;
        }
        if (isCollaborativeMultisigTemplate(remaining)) {
            return true;
        }
    }
    return false;
}

/**
 * Validates whether a script matches a submarine swap HTLC claim template:
 * - <hash> <HASH_OP> EQUALVERIFY <pubkey> CHECKSIG
 * - <hash> <HASH_OP> EQUAL VERIFY <pubkey> CHECKSIG
 * - <pubkey> CHECKSIGVERIFY <hash> <HASH_OP> EQUAL
 * - <condition> VERIFY <pubkey> CHECKSIG
 */
function isSwapClaimTemplate(decoded: (string | number | bigint | Uint8Array)[]): boolean {
    if (decoded.length === 5) {
        // [HASH_OP, hash_bytes, "EQUALVERIFY", pubkey, "CHECKSIG"] (standard Bitcoin script)
        if (
            isHashOpcode(decoded[0]) &&
            decoded[1] instanceof Uint8Array &&
            decoded[2] === "EQUALVERIFY" &&
            isKey(decoded[3]) &&
            decoded[4] === "CHECKSIG"
        ) {
            return true;
        }
        // [pubkey, "CHECKSIGVERIFY", HASH_OP, hash_bytes, "EQUAL"]
        if (
            isKey(decoded[0]) &&
            decoded[1] === "CHECKSIGVERIFY" &&
            isHashOpcode(decoded[2]) &&
            decoded[3] instanceof Uint8Array &&
            decoded[4] === "EQUAL"
        ) {
            return true;
        }
    }

    if (decoded.length === 6) {
        if (
            isHashOpcode(decoded[0]) &&
            decoded[1] instanceof Uint8Array &&
            decoded[2] === "EQUAL" &&
            decoded[3] === "VERIFY" &&
            isKey(decoded[4]) &&
            decoded[5] === "CHECKSIG"
        ) {
            return true;
        }
    }

    const verifyIdx = decoded.lastIndexOf("VERIFY");
    if (verifyIdx !== -1 && verifyIdx < decoded.length - 1) {
        const prefix = decoded.slice(0, verifyIdx);
        const hasHashLock = prefix.some((op) => isHashOpcode(op));
        const suffix = decoded.slice(verifyIdx + 1);
        if (hasHashLock) {
            if (suffix.length === 2 && isKey(suffix[0]) && suffix[1] === "CHECKSIG") {
                return true;
            }
            if (isCollaborativeMultisigTemplate(suffix)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Validates whether a script matches a submarine swap HTLC refund template:
 * - <locktime> CHECKLOCKTIMEVERIFY DROP <pubkey> CHECKSIG
 * - <pubkey> CHECKSIGVERIFY <locktime> CHECKLOCKTIMEVERIFY (Boltz submarine refund)
 * - <locktime> CHECKLOCKTIMEVERIFY DROP <multisig_template>
 * - <sequence> CHECKSEQUENCEVERIFY DROP <pubkey> CHECKSIG (also matches ArkStandardExit)
 */
function isSwapRefundTemplate(decoded: (string | number | bigint | Uint8Array)[]): boolean {
    if (decoded.length === 4) {
        // [pubkey, "CHECKSIGVERIFY", locktime, "CHECKLOCKTIMEVERIFY" | "CHECKSEQUENCEVERIFY"]
        if (
            isKey(decoded[0]) &&
            decoded[1] === "CHECKSIGVERIFY" &&
            (decoded[3] === "CHECKLOCKTIMEVERIFY" || decoded[3] === "CHECKSEQUENCEVERIFY")
        ) {
            return true;
        }
    }

    let ops = decoded;
    const verifyIdx = decoded.lastIndexOf("VERIFY");
    if (verifyIdx !== -1 && verifyIdx < decoded.length - 4) {
        ops = decoded.slice(verifyIdx + 1);
    }

    if (
        ops.length >= 5 &&
        (ops[1] === "CHECKLOCKTIMEVERIFY" || ops[1] === "CHECKSEQUENCEVERIFY") &&
        ops[2] === "DROP"
    ) {
        const remaining = ops.slice(3);
        if (remaining.length === 2 && isKey(remaining[0]) && remaining[1] === "CHECKSIG") {
            return true;
        }
        if (isCollaborativeMultisigTemplate(remaining)) {
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

    // Security Invariant (Finding 11 - Structural Template Matching):
    // Rather than loose opcode presence checks (which could be fooled by dead branches or decorative opcodes),
    // every tapleaf script must strictly match an allowlisted structural template:
    //   1. Standard Ark Unilateral Exit: <sequence> CSV DROP <pubkey> CHECKSIG (or collaborative multisig)
    //   2. Submarine Swap HTLC Claim: <hash> <HASH_OP> EQUALVERIFY <pubkey> CHECKSIG
    //   3. Submarine Swap HTLC Refund: <locktime> CLTV/CSV DROP <pubkey> CHECKSIG
    //   4. Collaborative Multisig / Forfeit: BIP 342 2-of-2 CHECKSIGVERIFY or CHECKSIGADD chain
    const isArkStandard = isArkStandardExitTemplate(decoded);
    const isSwapClaim = isSwapClaimTemplate(decoded);
    const isSwapRefund = isSwapRefundTemplate(decoded);
    const isCollaborativeMultisig = isCollaborativeMultisigTemplate(decoded);

    if (!isArkStandard && !isSwapClaim && !isSwapRefund && !isCollaborativeMultisig) {
        throw new VtxoVerificationError(
            `Tapleaf script in ${txid} does not follow Ark exit policy (CSV+CHECKSIG template), Swap policy (HTLC template), or Collaborative Multisig template (>=2 distinct keys in standard 2-of-2 format)`,
            "INVALID_ARK_SCRIPT",
        );
    }
}
