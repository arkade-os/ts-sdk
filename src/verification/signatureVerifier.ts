import { hex } from "@scure/base";
import { aggregateKeys } from "../musig2";
import { TxTree } from "../tree/txTree";
import { CosignerPublicKey, getArkPsbtFields } from "../utils/unknownFields";
import { verifyTapscriptSignatures } from "../utils/arkTransaction";
import { decodeTapscript } from "../script/tapscript";
import { scriptFromTapLeafScript } from "../script/base";
import type { Transaction } from "@scure/btc-signer/transaction.js";

export interface SignatureVerificationResult {
    txid: string;
    inputIndex: number;
    valid: boolean;
    signerKeys: string[];
    error?: string;
}

export interface CosignerKeyVerificationResult {
    txid: string;
    childIndex: number;
    valid: boolean;
    error?: string;
}

/**
 * Verifies all tapscript signatures across every transaction in the tree.
 *
 * For each transaction in the tree, verifies that:
 * - All tapScriptSig signatures are valid Schnorr signatures
 * - The signatures match the expected sighash
 * - All required signers have provided signatures
 *
 * @param tree - The TxTree to verify
 * @param excludePubkeys - Public keys to exclude from verification (e.g., server key if not yet signed)
 */
export function verifyTreeSignatures(
    tree: TxTree,
    excludePubkeys: string[] = []
): SignatureVerificationResult[] {
    const results: SignatureVerificationResult[] = [];

    for (const subtree of tree.iterator()) {
        const tx = subtree.root;
        for (let i = 0; i < tx.inputsLength; i++) {
            const input = tx.getInput(i);

            // Skip inputs without tapLeafScript (e.g., root input references commitment tx)
            if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
                continue;
            }

            // Derive expected signers from the tapscript leaf, not from existing signatures
            let expectedSigners: string[];
            try {
                const rawScript = scriptFromTapLeafScript(
                    input.tapLeafScript[0]
                );
                const decoded = decodeTapscript(rawScript);
                expectedSigners = (decoded.params.pubkeys ?? []).map(
                    (pk: Uint8Array) => hex.encode(pk)
                );
            } catch {
                // Can't decode script, fall back to tapScriptSig keys if present
                expectedSigners = (input.tapScriptSig ?? []).map(([data]) =>
                    hex.encode(data.pubKey)
                );
            }

            // If no signatures exist but signers are expected, report as invalid
            if (
                (!input.tapScriptSig || input.tapScriptSig.length === 0) &&
                expectedSigners.length > 0
            ) {
                const filteredSigners = expectedSigners.filter(
                    (pk) => !excludePubkeys.includes(pk)
                );
                if (filteredSigners.length > 0) {
                    results.push({
                        txid: tx.id,
                        inputIndex: i,
                        valid: false,
                        signerKeys: expectedSigners,
                        error: `Missing all signatures from: ${filteredSigners.map((pk) => pk.slice(0, 16)).join(", ")}...`,
                    });
                }
                continue;
            }

            try {
                verifyTapscriptSignatures(
                    tx,
                    i,
                    expectedSigners,
                    excludePubkeys
                );
                results.push({
                    txid: tx.id,
                    inputIndex: i,
                    valid: true,
                    signerKeys: expectedSigners,
                });
            } catch (err) {
                results.push({
                    txid: tx.id,
                    inputIndex: i,
                    valid: false,
                    signerKeys: expectedSigners,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }

    return results;
}

/**
 * Verifies that the cosigner public keys in each child transaction's PSBT fields
 * correctly aggregate to produce the parent output's taproot key.
 *
 * This check ensures the n-of-n MuSig2 key path is correctly constructed,
 * meaning all cosigners must cooperate to spend via the key path.
 *
 * @param tree - The TxTree to verify
 * @param sweepTapTreeRoot - The sweep tapscript tree root hash used for taproot tweaking
 */
export function verifyCosignerKeys(
    tree: TxTree,
    sweepTapTreeRoot: Uint8Array
): CosignerKeyVerificationResult[] {
    const results: CosignerKeyVerificationResult[] = [];

    for (const subtree of tree.iterator()) {
        for (const [childIndex, child] of subtree.children) {
            const parentOutput = subtree.root.getOutput(childIndex);
            if (!parentOutput?.script) {
                results.push({
                    txid: subtree.root.id,
                    childIndex,
                    valid: false,
                    error: `Parent output ${childIndex} not found`,
                });
                continue;
            }

            const script = parentOutput.script;
            if (
                script.length !== 34 ||
                script[0] !== 0x51 ||
                script[1] !== 0x20
            ) {
                results.push({
                    txid: subtree.root.id,
                    childIndex,
                    valid: false,
                    error: `Parent output ${childIndex} is not a taproot key-path output`,
                });
                continue;
            }
            const previousScriptKey = script.subarray(2);

            const cosigners = getArkPsbtFields(
                child.root,
                0,
                CosignerPublicKey
            );

            if (cosigners.length === 0) {
                results.push({
                    txid: subtree.root.id,
                    childIndex,
                    valid: false,
                    error: "Missing cosigner public keys",
                });
                continue;
            }

            const cosignerKeys = cosigners.map((c) => c.key);

            try {
                const { finalKey } = aggregateKeys(cosignerKeys, true, {
                    taprootTweak: sweepTapTreeRoot,
                });

                const valid =
                    !!finalKey &&
                    hex.encode(finalKey.slice(1)) ===
                        hex.encode(previousScriptKey);

                results.push({
                    txid: subtree.root.id,
                    childIndex,
                    valid,
                    error: valid
                        ? undefined
                        : "Aggregated key does not match parent output script",
                });
            } catch (err) {
                results.push({
                    txid: subtree.root.id,
                    childIndex,
                    valid: false,
                    error: `Key aggregation failed: ${err instanceof Error ? err.message : String(err)}`,
                });
            }
        }
    }

    return results;
}
