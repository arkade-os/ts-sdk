import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { SigHash, TAPROOT_UNSPENDABLE_KEY } from "@scure/btc-signer";
import { ChainTxType } from "../providers/indexer";
import { scriptFromTapLeafScript } from "../script/base";
import { decodeTapscript } from "../script/tapscript";
import { verifyTapscriptSignatures } from "../utils/arkTransaction";
import type { Transaction } from "../utils/transaction";
import type { ParsedVtxoProof, VtxoVerificationIssue } from "./types";

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
        if (!input.tapLeafScript || input.tapLeafScript.length === 0) continue;

        const internalKey = input.tapLeafScript[0][0]?.internalKey;
        if (!internalKey || hex.encode(internalKey) !== hex.encode(TAPROOT_UNSPENDABLE_KEY)) {
            issues.push({
                code: "signature_internal_key_spendable",
                message: `Transaction ${txid} input ${inputIndex} does not use the NUMS internal key`,
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
