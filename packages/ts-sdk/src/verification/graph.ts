import { hex } from "@scure/base";
import { ChainTxType } from "../providers/indexer";
import type { VirtualCoin } from "../wallet";
import type { ParsedVtxoProof, VtxoVerificationIssue } from "./types";

export function hydrateVirtualPrevouts(proof: ParsedVtxoProof): VtxoVerificationIssue[] {
    const issues: VtxoVerificationIssue[] = [];

    for (const [txid, tx] of proof.transactions) {
        for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
            const input = tx.getInput(inputIndex);
            if (!input.txid || input.index === undefined) continue;

            const parentTxid = hex.encode(input.txid);
            const parent = proof.transactions.get(parentTxid);
            if (!parent) continue;

            const parentOutput =
                input.index >= 0 && input.index < parent.outputsLength
                    ? parent.getOutput(input.index)
                    : undefined;
            if (parentOutput?.amount === undefined || !parentOutput.script) {
                issues.push({
                    code: "graph_parent_output_missing",
                    message: `Parent output ${parentTxid}:${input.index} does not exist`,
                    txid,
                    inputIndex,
                });
                continue;
            }

            if (!input.witnessUtxo) {
                tx.updateInput(inputIndex, {
                    witnessUtxo: {
                        amount: parentOutput.amount,
                        script: parentOutput.script,
                    },
                });
                continue;
            }

            if (
                input.witnessUtxo.amount !== parentOutput.amount ||
                hex.encode(input.witnessUtxo.script) !== hex.encode(parentOutput.script)
            ) {
                issues.push({
                    code: "graph_prevout_mismatch",
                    message: `Input prevout does not match ${parentTxid}:${input.index}`,
                    txid,
                    inputIndex,
                });
            }
        }
    }

    return issues;
}

export function verifyClaimedLeaf(
    vtxo: VirtualCoin,
    proof: ParsedVtxoProof,
): VtxoVerificationIssue[] {
    const txid = vtxo.txid.toLowerCase();
    const tx = proof.transactions.get(txid);
    if (!tx) {
        return [
            {
                code: "leaf_tx_missing",
                message: `Claimed VTXO transaction ${txid} is absent from the proof`,
                txid,
            },
        ];
    }
    if (vtxo.vout < 0 || vtxo.vout >= tx.outputsLength) {
        return [
            {
                code: "leaf_output_missing",
                message: `Claimed VTXO output ${txid}:${vtxo.vout} does not exist`,
                txid,
                outputIndex: vtxo.vout,
            },
        ];
    }
    const output = tx.getOutput(vtxo.vout);
    if (output?.amount === undefined || !output.script) {
        return [
            {
                code: "leaf_output_incomplete",
                message: `Claimed VTXO output ${txid}:${vtxo.vout} has no amount or script`,
                txid,
                outputIndex: vtxo.vout,
            },
        ];
    }

    const issues: VtxoVerificationIssue[] = [];
    if (BigInt(vtxo.value) !== output.amount) {
        issues.push({
            code: "leaf_amount_mismatch",
            message: `Claimed amount ${vtxo.value} does not match output amount ${output.amount}`,
            txid,
            outputIndex: vtxo.vout,
        });
    }
    if (!vtxo.script || vtxo.script.toLowerCase() !== hex.encode(output.script)) {
        issues.push({
            code: "leaf_script_mismatch",
            message: "Claimed script does not match the virtual transaction output",
            txid,
            outputIndex: vtxo.vout,
        });
    }
    return issues;
}

export function verifyGraphSegments(proof: ParsedVtxoProof): VtxoVerificationIssue[] {
    const issues: VtxoVerificationIssue[] = [];
    const spentOutputs = new Set<string>();

    for (const [txid, entry] of proof.entries) {
        const tx = proof.transactions.get(txid);
        if (!tx) continue;
        if (entry.type === ChainTxType.ARK || entry.type === ChainTxType.CHECKPOINT) {
            let inputAmount = 0n;
            let completeInputs = true;
            for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
                const input = tx.getInput(inputIndex);
                if (!input.txid || input.index === undefined) {
                    issues.push({
                        code: "graph_input_incomplete",
                        message: `Transaction ${txid} input ${inputIndex} has incomplete parent data`,
                        txid,
                        inputIndex,
                    });
                    completeInputs = false;
                    continue;
                }
                const parentKey = `${hex.encode(input.txid)}:${input.index}`;
                if (spentOutputs.has(parentKey)) {
                    issues.push({
                        code: "graph_duplicate_spend",
                        message: `Multiple transactions spend ${parentKey}`,
                        txid,
                        inputIndex,
                    });
                }
                spentOutputs.add(parentKey);
                if (!input.witnessUtxo) {
                    completeInputs = false;
                    continue;
                }
                inputAmount += input.witnessUtxo.amount;
            }
            let outputAmount = 0n;
            for (let outputIndex = 0; outputIndex < tx.outputsLength; outputIndex++) {
                outputAmount += tx.getOutput(outputIndex)?.amount ?? 0n;
            }
            if (completeInputs && outputAmount > inputAmount) {
                issues.push({
                    code: "graph_amount_mismatch",
                    message: `Transaction ${txid} outputs ${outputAmount} but spends ${inputAmount}`,
                    txid,
                });
            }
            continue;
        }
        if (entry.type !== ChainTxType.TREE) continue;
        if (tx.inputsLength !== 1) {
            issues.push({
                code: "graph_input_count",
                message: `TREE transaction ${txid} has ${tx.inputsLength} inputs, expected 1`,
                txid,
            });
            continue;
        }
        const input = tx.getInput(0);
        if (!input.txid || input.index === undefined || !input.witnessUtxo) {
            issues.push({
                code: "graph_input_incomplete",
                message: `TREE transaction ${txid} has incomplete parent data`,
                txid,
                inputIndex: 0,
            });
            continue;
        }

        const parentTxid = hex.encode(input.txid);
        const parentKey = `${parentTxid}:${input.index}`;
        if (spentOutputs.has(parentKey)) {
            issues.push({
                code: "graph_duplicate_spend",
                message: `Multiple transactions spend ${parentKey}`,
                txid,
                inputIndex: 0,
            });
            continue;
        }
        spentOutputs.add(parentKey);

        let outputAmount = 0n;
        for (let outputIndex = 0; outputIndex < tx.outputsLength; outputIndex++) {
            outputAmount += tx.getOutput(outputIndex)?.amount ?? 0n;
        }
        if (outputAmount !== input.witnessUtxo.amount) {
            issues.push({
                code: "graph_amount_mismatch",
                message: `TREE transaction ${txid} outputs ${outputAmount} but spends ${input.witnessUtxo.amount}`,
                txid,
                inputIndex: 0,
            });
        }

        const parentEntry = proof.entries.get(parentTxid);
        if (!parentEntry) {
            issues.push({
                code: "graph_parent_missing",
                message: `TREE transaction ${txid} has unknown parent ${parentTxid}`,
                txid,
                inputIndex: 0,
            });
            continue;
        }
        if (parentEntry.type === ChainTxType.COMMITMENT) continue;
        if (parentEntry.type !== ChainTxType.TREE) {
            issues.push({
                code: "graph_parent_type",
                message: `TREE transaction ${txid} has non-TREE virtual parent ${parentTxid}`,
                txid,
                inputIndex: 0,
            });
            continue;
        }

        const parent = proof.transactions.get(parentTxid);
        const parentOutput =
            parent && input.index >= 0 && input.index < parent.outputsLength
                ? parent.getOutput(input.index)
                : undefined;
        if (parentOutput?.amount === undefined || !parentOutput.script) {
            issues.push({
                code: "graph_parent_output_missing",
                message: `Parent output ${parentKey} does not exist`,
                txid,
                inputIndex: 0,
            });
            continue;
        }
        if (parentOutput.amount !== input.witnessUtxo.amount) {
            issues.push({
                code: "graph_amount_mismatch",
                message: `TREE transaction ${txid} input amount does not match ${parentKey}`,
                txid,
                inputIndex: 0,
            });
        }
        if (hex.encode(parentOutput.script) !== hex.encode(input.witnessUtxo.script)) {
            issues.push({
                code: "graph_prevout_mismatch",
                message: `TREE transaction ${txid} input script does not match ${parentKey}`,
                txid,
                inputIndex: 0,
            });
        }
    }

    return issues;
}
