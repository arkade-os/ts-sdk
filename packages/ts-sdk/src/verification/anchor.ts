import { hex } from "@scure/base";
import { ChainTxType } from "../providers/indexer";
import { Transaction } from "../utils/transaction";
import type { ParsedVtxoProof, VtxoChainSource, VtxoVerificationIssue } from "./types";

export class VtxoVerificationUnavailableError extends Error {
    constructor(
        readonly code: string,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "VtxoVerificationUnavailableError";
    }
}

export async function verifyCommitmentAnchors(
    proof: ParsedVtxoProof,
    source: VtxoChainSource,
    minConfirmationDepth: number,
): Promise<{ confirmationDepth: number; issues: VtxoVerificationIssue[] }> {
    let tip: Awaited<ReturnType<VtxoChainSource["getChainTip"]>>;
    try {
        tip = await source.getChainTip();
    } catch (error) {
        throw unavailable("anchor_tip_unavailable", "Could not fetch the Bitcoin chain tip", error);
    }

    const issues: VtxoVerificationIssue[] = [];
    let minimumDepth = Number.POSITIVE_INFINITY;

    for (const commitmentTxid of proof.commitmentTxids) {
        const roots = findCommitmentRoots(proof, commitmentTxid);
        if (roots.length === 0) {
            issues.push({
                code: "anchor_root_missing",
                message: `No TREE transaction spends commitment ${commitmentTxid}`,
                txid: commitmentTxid,
            });
            continue;
        }

        let rawHex: string;
        let status: Awaited<ReturnType<VtxoChainSource["getTxStatus"]>>;
        let outspends: Awaited<ReturnType<VtxoChainSource["getTxOutspends"]>>;
        try {
            [rawHex, status, outspends] = await Promise.all([
                source.getTxHex(commitmentTxid),
                source.getTxStatus(commitmentTxid),
                source.getTxOutspends(commitmentTxid),
            ]);
        } catch (error) {
            throw unavailable(
                "anchor_data_unavailable",
                `Could not fetch Bitcoin data for commitment ${commitmentTxid}`,
                error,
            );
        }

        let commitment: Transaction;
        try {
            commitment = Transaction.fromRaw(hex.decode(rawHex), {
                allowUnknownInputs: true,
                allowUnknownOutputs: true,
            });
        } catch (error) {
            issues.push({
                code: "anchor_transaction_malformed",
                message: `Commitment ${commitmentTxid} raw transaction is malformed: ${message(error)}`,
                txid: commitmentTxid,
            });
            continue;
        }
        if (commitment.id !== commitmentTxid) {
            issues.push({
                code: "anchor_txid_mismatch",
                message: `Fetched transaction ${commitment.id} does not match ${commitmentTxid}`,
                txid: commitmentTxid,
            });
            continue;
        }

        if (!status.confirmed) {
            issues.push({
                code: "anchor_unconfirmed",
                message: `Commitment ${commitmentTxid} is not confirmed`,
                txid: commitmentTxid,
            });
        } else {
            const depth = tip.height - status.blockHeight + 1;
            minimumDepth = Math.min(minimumDepth, depth);
            if (depth < minConfirmationDepth) {
                issues.push({
                    code: "anchor_depth_insufficient",
                    message: `Commitment ${commitmentTxid} depth ${depth} is below ${minConfirmationDepth}`,
                    txid: commitmentTxid,
                });
            }
        }

        for (const root of roots) {
            const rootInput = root.tx.getInput(root.inputIndex);
            if (rootInput.index === undefined) {
                issues.push({
                    code: "anchor_root_prevout_missing",
                    message: `TREE root ${root.tx.id} has no commitment output index`,
                    txid: root.tx.id,
                    inputIndex: root.inputIndex,
                });
                continue;
            }

            const output =
                rootInput.index >= 0 && rootInput.index < commitment.outputsLength
                    ? commitment.getOutput(rootInput.index)
                    : undefined;
            if (output?.amount === undefined || !output.script) {
                issues.push({
                    code: "anchor_output_missing",
                    message: `Commitment output ${commitmentTxid}:${rootInput.index} does not exist`,
                    txid: commitmentTxid,
                    outputIndex: rootInput.index,
                });
                continue;
            }
            if (rootInput.witnessUtxo && output.amount !== rootInput.witnessUtxo.amount) {
                issues.push({
                    code: "anchor_amount_mismatch",
                    message: `Commitment output amount ${output.amount} does not match TREE prevout ${rootInput.witnessUtxo.amount}`,
                    txid: commitmentTxid,
                    outputIndex: rootInput.index,
                });
            }
            if (
                rootInput.witnessUtxo &&
                hex.encode(output.script) !== hex.encode(rootInput.witnessUtxo.script)
            ) {
                issues.push({
                    code: "anchor_script_mismatch",
                    message: "Commitment output script does not match the TREE root prevout",
                    txid: commitmentTxid,
                    outputIndex: rootInput.index,
                });
            }
            if (!rootInput.witnessUtxo) {
                root.tx.updateInput(root.inputIndex, {
                    witnessUtxo: { amount: output.amount, script: output.script },
                });
            }

            const outspend = outspends[rootInput.index];
            if (!outspend?.spent) continue;
            if (!outspend.txid) {
                issues.push({
                    code: "anchor_spender_unknown",
                    message: `Commitment output ${commitmentTxid}:${rootInput.index} is spent by an unknown transaction`,
                    txid: commitmentTxid,
                    outputIndex: rootInput.index,
                });
            } else if (outspend.txid !== root.tx.id) {
                issues.push({
                    code: "anchor_unexpected_spend",
                    message: `Commitment output ${commitmentTxid}:${rootInput.index} was spent by ${outspend.txid}`,
                    txid: commitmentTxid,
                    outputIndex: rootInput.index,
                });
            }
        }
    }

    return {
        confirmationDepth: Number.isFinite(minimumDepth) ? minimumDepth : 0,
        issues,
    };
}

function findCommitmentRoots(proof: ParsedVtxoProof, commitmentTxid: string) {
    const roots: { tx: Transaction; inputIndex: number }[] = [];
    for (const [txid, entry] of proof.entries) {
        if (entry.type !== ChainTxType.TREE) continue;
        const tx = proof.transactions.get(txid);
        if (!tx) continue;
        for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
            const input = tx.getInput(inputIndex);
            if (input.txid && hex.encode(input.txid) === commitmentTxid) {
                roots.push({ tx, inputIndex });
            }
        }
    }
    return roots;
}

function unavailable(code: string, text: string, cause: unknown) {
    return new VtxoVerificationUnavailableError(code, `${text}: ${message(cause)}`, { cause });
}

function message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
