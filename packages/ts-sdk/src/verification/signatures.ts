import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { SigHash, TAPROOT_UNSPENDABLE_KEY } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { compareBytes, taprootTweakPubkey } from "@scure/btc-signer/utils.js";
import { aggregateKeys } from "../musig2";
import { ChainTxType } from "../providers/indexer";
import { scriptFromTapLeafScript } from "../script/base";
import { CSVMultisigTapscript, decodeTapscript } from "../script/tapscript";
import { verifyTapscriptSignatures } from "../utils/arkTransaction";
import { CosignerPublicKey, getArkPsbtFields, VtxoTreeExpiry } from "../utils/unknownFields";
import type { Transaction } from "../utils/transaction";
import type { ParsedVtxoProof, VtxoVerificationIssue, VtxoVerificationServerInfo } from "./types";

export function verifyTreeCosignerKeys(
    proof: ParsedVtxoProof,
    serverInfo: VtxoVerificationServerInfo,
): VtxoVerificationIssue[] {
    const issues: VtxoVerificationIssue[] = [];

    for (const [txid, entry] of proof.entries) {
        if (entry.type !== ChainTxType.TREE) continue;
        const tx = proof.transactions.get(txid);
        if (!tx) continue;

        for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
            const input = tx.getInput(inputIndex);
            const script = input.witnessUtxo?.script;
            if (!script || script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) {
                continue;
            }

            const cosigners = getArkPsbtFields(tx, inputIndex, CosignerPublicKey);
            if (cosigners.length === 0) {
                issues.push({
                    code: "signature_cosigner_missing",
                    message: `TREE transaction ${txid} input ${inputIndex} has no cosigner keys`,
                    txid,
                    inputIndex,
                });
                continue;
            }

            const expiries = getArkPsbtFields(tx, inputIndex, VtxoTreeExpiry);
            if (expiries.length !== 1) {
                issues.push({
                    code:
                        expiries.length === 0
                            ? "signature_sweep_expiry_missing"
                            : "signature_sweep_expiry_ambiguous",
                    message: `TREE transaction ${txid} input ${inputIndex} must have exactly one sweep expiry`,
                    txid,
                    inputIndex,
                });
                continue;
            }

            try {
                const sweepScript = CSVMultisigTapscript.encode({
                    timelock: expiries[0],
                    pubkeys: [serverInfo.forfeitPubkey],
                }).script;
                const { finalKey } = aggregateKeys(
                    cosigners.map((cosigner) => cosigner.key),
                    true,
                    { taprootTweak: tapLeafHash(sweepScript) },
                );
                if (hex.encode(finalKey.subarray(1)) !== hex.encode(script.subarray(2))) {
                    issues.push({
                        code: "signature_cosigner_key_mismatch",
                        message: `TREE transaction ${txid} input ${inputIndex} cosigners do not match its prevout`,
                        txid,
                        inputIndex,
                    });
                }
            } catch (error) {
                issues.push({
                    code: "signature_cosigner_invalid",
                    message: `TREE transaction ${txid} input ${inputIndex} has invalid cosigner keys: ${errorMessage(error)}`,
                    txid,
                    inputIndex,
                });
            }
        }
    }

    return issues;
}

export function verifyProofSignatures(proof: ParsedVtxoProof): VtxoVerificationIssue[] {
    const issues: VtxoVerificationIssue[] = [];

    for (const [txid, entry] of proof.entries) {
        const tx = proof.transactions.get(txid);
        if (!tx) continue;
        if (entry.type !== ChainTxType.TREE) {
            verifyScriptPathSignatures(txid, tx, issues);
            continue;
        }

        const prevoutScripts: Uint8Array[] = [];
        const prevoutAmounts: bigint[] = [];
        let completePrevouts = true;
        for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
            const witnessUtxo = tx.getInput(inputIndex).witnessUtxo;
            if (!witnessUtxo) {
                issues.push({
                    code: "signature_prevout_missing",
                    message: `TREE transaction ${txid} input ${inputIndex} has no witness UTXO`,
                    txid,
                    inputIndex,
                });
                completePrevouts = false;
                continue;
            }
            prevoutScripts.push(witnessUtxo.script);
            prevoutAmounts.push(witnessUtxo.amount);
        }
        if (!completePrevouts) continue;

        for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
            const input = tx.getInput(inputIndex);
            const script = input.witnessUtxo!.script;
            if (script.length !== 34 || script[0] !== 0x51 || script[1] !== 0x20) {
                issues.push({
                    code: "signature_prevout_not_p2tr",
                    message: `TREE transaction ${txid} input ${inputIndex} does not spend P2TR`,
                    txid,
                    inputIndex,
                });
                continue;
            }
            if (!input.tapKeySig) {
                issues.push({
                    code: "signature_missing_tap_key",
                    message: `TREE transaction ${txid} input ${inputIndex} has no tapKeySig`,
                    txid,
                    inputIndex,
                });
                continue;
            }

            const encodedSignature = input.tapKeySig;
            const sighashType =
                encodedSignature.length === 65 ? encodedSignature[64] : SigHash.DEFAULT;
            if (encodedSignature.length !== 64 && encodedSignature.length !== 65) {
                issues.push({
                    code: "signature_invalid_tap_key",
                    message: `TREE transaction ${txid} input ${inputIndex} has an invalid signature length`,
                    txid,
                    inputIndex,
                });
                continue;
            }
            if (sighashType !== SigHash.DEFAULT) {
                issues.push({
                    code: "signature_sighash_unsupported",
                    message: `TREE transaction ${txid} input ${inputIndex} uses unsupported sighash ${sighashType}`,
                    txid,
                    inputIndex,
                });
                continue;
            }

            const message = tx.preimageWitnessV1(
                inputIndex,
                prevoutScripts,
                sighashType,
                prevoutAmounts,
            );
            const signature = encodedSignature.subarray(0, 64);
            const outputKey = script.subarray(2);
            let valid = false;
            try {
                valid = schnorr.verify(signature, message, outputKey);
            } catch {
                valid = false;
            }
            if (!valid) {
                issues.push({
                    code: "signature_invalid_tap_key",
                    message: `TREE transaction ${txid} input ${inputIndex} has an invalid tapKeySig`,
                    txid,
                    inputIndex,
                });
            }
        }
    }

    return issues;
}

function verifyScriptPathSignatures(
    txid: string,
    tx: Transaction,
    issues: VtxoVerificationIssue[],
): void {
    for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
        const input = tx.getInput(inputIndex);
        if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
            issues.push({
                code: "signature_script_path_missing",
                message: `Transaction ${txid} input ${inputIndex} has no tapscript proof`,
                txid,
                inputIndex,
            });
            continue;
        }

        if (
            input.tapLeafScript.some(
                ([controlBlock]) =>
                    hex.encode(controlBlock.internalKey) !== hex.encode(TAPROOT_UNSPENDABLE_KEY),
            )
        ) {
            issues.push({
                code: "signature_internal_key_spendable",
                message: `Transaction ${txid} input ${inputIndex} does not use the NUMS internal key`,
                txid,
                inputIndex,
            });
            continue;
        }

        if (
            !input.witnessUtxo ||
            input.tapLeafScript.some(
                ([controlBlock, scriptWithVersion]) =>
                    !tapLeafBindsToPrevout(
                        controlBlock,
                        scriptWithVersion,
                        input.witnessUtxo!.script,
                    ),
            )
        ) {
            issues.push({
                code: "signature_tapleaf_unbound",
                message: `Transaction ${txid} input ${inputIndex} tapscript is not bound to its prevout`,
                txid,
                inputIndex,
            });
            continue;
        }

        try {
            const script = scriptFromTapLeafScript(input.tapLeafScript[0]);
            const decoded = decodeTapscript(script);
            const requiredSigners = (decoded.params.pubkeys ?? []).map((key: Uint8Array) =>
                hex.encode(key),
            );
            verifyTapscriptSignatures(tx, inputIndex, requiredSigners);
        } catch (error) {
            issues.push({
                code: "signature_invalid_script_path",
                message: `Transaction ${txid} input ${inputIndex} script signature failed: ${errorMessage(error)}`,
                txid,
                inputIndex,
            });
        }
    }
}

function tapLeafBindsToPrevout(
    controlBlock: {
        version: number;
        internalKey: Uint8Array;
        merklePath: Uint8Array[];
    },
    scriptWithVersion: Uint8Array,
    prevoutScript: Uint8Array,
): boolean {
    if (
        scriptWithVersion.length === 0 ||
        prevoutScript.length !== 34 ||
        prevoutScript[0] !== 0x51 ||
        prevoutScript[1] !== 0x20
    ) {
        return false;
    }

    const leafVersion = scriptWithVersion[scriptWithVersion.length - 1];
    if ((controlBlock.version & 0xfe) !== leafVersion) return false;

    let merkleRoot = tapLeafHash(scriptWithVersion.subarray(0, -1), leafVersion);
    for (const sibling of controlBlock.merklePath) {
        const [left, right] =
            compareBytes(merkleRoot, sibling) <= 0 ? [merkleRoot, sibling] : [sibling, merkleRoot];
        merkleRoot = schnorr.utils.taggedHash("TapBranch", left, right);
    }

    try {
        const [outputKey, parity] = taprootTweakPubkey(controlBlock.internalKey, merkleRoot);
        return (
            parity === (controlBlock.version & 1) &&
            hex.encode(outputKey) === hex.encode(prevoutScript.subarray(2))
        );
    } catch {
        return false;
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
