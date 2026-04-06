import { errorMessage } from "./utils";
import { hex } from "@scure/base";
import { TAPROOT_UNSPENDABLE_KEY } from "@scure/btc-signer";
import { compareBytes } from "@scure/btc-signer/utils.js";
import { aggregateKeys } from "../musig2";
import { findInputIndexSpendingOutpoint, TxTree } from "../tree/txTree";
import { CosignerPublicKey, getArkPsbtFields } from "../utils/unknownFields";
import { verifyTapscriptSignatures } from "../utils/arkTransaction";
import { decodeTapscript } from "../script/tapscript";
import { scriptFromTapLeafScript } from "../script/base";

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

export function verifyTreeSignatures(
    tree: TxTree,
    excludePubkeys: string[] = []
): SignatureVerificationResult[] {
    const results: SignatureVerificationResult[] = [];

    for (const subtree of tree.iterator()) {
        const tx = subtree.root;
        for (let i = 0; i < tx.inputsLength; i++) {
            const input = tx.getInput(i);

            if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
                continue;
            }

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
                expectedSigners = (input.tapScriptSig ?? []).map(([data]) =>
                    hex.encode(data.pubKey)
                );
            }

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
                    error: errorMessage(err),
                });
            }
        }
    }

    return results;
}

export interface InternalKeyVerificationResult {
    txid: string;
    inputIndex: number;
    valid: boolean;
    error?: string;
}

/**
 * Verifies that all taproot inputs in the tree use the standard
 * TAPROOT_UNSPENDABLE_KEY (NUMS point) as the internal key,
 * ensuring only the script path is spendable.
 */
export function verifyInternalKeysUnspendable(
    tree: TxTree
): InternalKeyVerificationResult[] {
    const results: InternalKeyVerificationResult[] = [];

    for (const subtree of tree.iterator()) {
        const tx = subtree.root;
        for (let i = 0; i < tx.inputsLength; i++) {
            const input = tx.getInput(i);
            if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
                continue;
            }

            const internalKey = input.tapLeafScript[0][0]?.internalKey;
            if (!internalKey) {
                continue;
            }

            if (compareBytes(internalKey, TAPROOT_UNSPENDABLE_KEY) !== 0) {
                results.push({
                    txid: tx.id,
                    inputIndex: i,
                    valid: false,
                    error: `Internal key ${hex.encode(internalKey).slice(0, 16)}... is not the unspendable NUMS point`,
                });
            } else {
                results.push({
                    txid: tx.id,
                    inputIndex: i,
                    valid: true,
                });
            }
        }
    }

    return results;
}

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

            const childInputIndex = findInputIndexSpendingOutpoint(
                child.root,
                subtree.root.id,
                childIndex
            );
            if (childInputIndex === null) {
                results.push({
                    txid: subtree.root.id,
                    childIndex,
                    valid: false,
                    error: `Child does not spend parent output ${childIndex}`,
                });
                continue;
            }

            const cosigners = getArkPsbtFields(
                child.root,
                childInputIndex,
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
                    compareBytes(finalKey.slice(1), previousScriptKey) === 0;

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
                    error: `Key aggregation failed: ${errorMessage(err)}`,
                });
            }
        }
    }

    return results;
}
