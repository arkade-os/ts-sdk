import { hex } from "@scure/base";
import { ChainTxType } from "../providers/indexer";
import type { VirtualCoin } from "../wallet";
import type { ParsedVtxoProof, VtxoVerificationIssue } from "./types";

export function verifyClaimedLeaf(
    vtxo: VirtualCoin,
    proof: ParsedVtxoProof,
): VtxoVerificationIssue[] {
    const tx = proof.transactions.get(vtxo.txid);
    if (!tx) {
        return [
            {
                code: "leaf_tx_missing",
                message: `Claimed VTXO transaction ${vtxo.txid} is absent from the proof`,
                txid: vtxo.txid,
            },
        ];
    }
    if (vtxo.vout < 0 || vtxo.vout >= tx.outputsLength) {
        return [
            {
                code: "leaf_output_missing",
                message: `Claimed VTXO output ${vtxo.txid}:${vtxo.vout} does not exist`,
                txid: vtxo.txid,
                outputIndex: vtxo.vout,
            },
        ];
    }
    const output = tx.getOutput(vtxo.vout);
    if (output?.amount === undefined || !output.script) {
        return [
            {
                code: "leaf_output_incomplete",
                message: `Claimed VTXO output ${vtxo.txid}:${vtxo.vout} has no amount or script`,
                txid: vtxo.txid,
                outputIndex: vtxo.vout,
            },
        ];
    }

    const issues: VtxoVerificationIssue[] = [];
    if (BigInt(vtxo.value) !== output.amount) {
        issues.push({
            code: "leaf_amount_mismatch",
            message: `Claimed amount ${vtxo.value} does not match output amount ${output.amount}`,
            txid: vtxo.txid,
            outputIndex: vtxo.vout,
        });
    }
    if (!vtxo.script || vtxo.script.toLowerCase() !== hex.encode(output.script)) {
        issues.push({
            code: "leaf_script_mismatch",
            message: "Claimed script does not match the virtual transaction output",
            txid: vtxo.txid,
            outputIndex: vtxo.vout,
        });
    }
    return issues;
}

export function verifyGraphSegments(proof: ParsedVtxoProof): VtxoVerificationIssue[] {
    const issues: VtxoVerificationIssue[] = [];
    const spentOutputs = new Set<string>();

    for (const [txid, entry] of proof.entries) {
        if (entry.type !== ChainTxType.TREE) continue;
        const tx = proof.transactions.get(txid);
        if (!tx) continue;
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
                message: `Multiple TREE transactions spend ${parentKey}`,
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
        const parentOutput = parent?.getOutput(input.index);
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
