import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import type { OnchainProvider } from "../providers/onchain";

export interface AnchorVerification {
    commitmentTxid: string;
    confirmed: boolean;
    blockHeight?: number;
    blockTime?: number;
    confirmationDepth: number;
    outputMatches: boolean;
    doubleSpent: boolean;
    errors: string[];
    warnings: string[];
}

/**
 * Verifies that a commitment transaction is properly anchored onchain.
 *
 * Checks:
 * - The commitment tx exists and is confirmed
 * - The confirmation depth meets the minimum threshold
 * - The referenced output amount and script match expectations
 * - The referenced output has not been double-spent
 *
 * @param commitmentTxid - The txid of the commitment transaction
 * @param expectedOutputIndex - The output index to verify (typically 0 for batch output)
 * @param expectedAmount - The expected output amount in satoshis
 * @param expectedScript - The expected output script (raw bytes)
 * @param onchain - OnchainProvider instance for querying the blockchain
 * @param minDepth - Minimum confirmation depth (default: 6)
 */
export async function verifyOnchainAnchor(
    commitmentTxid: string,
    expectedOutputIndex: number,
    expectedAmount: bigint,
    expectedScript: Uint8Array,
    onchain: OnchainProvider,
    minDepth: number = 6
): Promise<AnchorVerification> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Step 1: Check confirmation status
    let confirmed = false;
    let blockHeight: number | undefined;
    let blockTime: number | undefined;
    let confirmationDepth = 0;

    try {
        const txStatus = await onchain.getTxStatus(commitmentTxid);
        if (txStatus.confirmed) {
            confirmed = true;
            blockHeight = txStatus.blockHeight;
            blockTime = txStatus.blockTime;

            // Calculate confirmation depth
            const chainTip = await onchain.getChainTip();
            confirmationDepth = chainTip.height - txStatus.blockHeight + 1;

            if (confirmationDepth < minDepth) {
                warnings.push(
                    `Low confirmation depth: ${confirmationDepth} (minimum: ${minDepth})`
                );
            }
        } else {
            errors.push("Commitment transaction is not confirmed");
        }
    } catch (err) {
        errors.push(
            `Failed to get commitment tx status: ${err instanceof Error ? err.message : String(err)}`
        );
        return {
            commitmentTxid,
            confirmed: false,
            confirmationDepth: 0,
            outputMatches: false,
            doubleSpent: false,
            errors,
            warnings,
        };
    }

    // Step 2: Fetch raw transaction and verify output
    let outputMatches = false;
    try {
        const txHex = await onchain.getTxHex(commitmentTxid);
        const tx = Transaction.fromRaw(hex.decode(txHex));

        if (tx.outputsLength <= expectedOutputIndex) {
            errors.push(
                `Commitment tx has ${tx.outputsLength} outputs, expected at least ${expectedOutputIndex + 1}`
            );
        } else {
            const output = tx.getOutput(expectedOutputIndex);
            if (!output?.amount || !output?.script) {
                errors.push(
                    `Commitment tx output ${expectedOutputIndex} is missing amount or script`
                );
            } else {
                const amountMatch = output.amount === expectedAmount;
                const scriptMatch =
                    hex.encode(output.script) === hex.encode(expectedScript);

                if (!amountMatch) {
                    errors.push(
                        `Output amount mismatch: expected ${expectedAmount}, got ${output.amount}`
                    );
                }
                if (!scriptMatch) {
                    errors.push(
                        `Output script mismatch at index ${expectedOutputIndex}`
                    );
                }

                outputMatches = amountMatch && scriptMatch;
            }
        }
    } catch (err) {
        errors.push(
            `Failed to fetch commitment tx hex: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    // Step 3: Check for double-spend
    let doubleSpent = false;
    try {
        const outspends = await onchain.getTxOutspends(commitmentTxid);
        if (
            outspends.length > expectedOutputIndex &&
            outspends[expectedOutputIndex].spent
        ) {
            doubleSpent = true;
            errors.push(
                `Commitment tx output ${expectedOutputIndex} has been spent by ${outspends[expectedOutputIndex].txid}`
            );
        }
    } catch (err) {
        warnings.push(
            `Failed to check double-spend status: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    return {
        commitmentTxid,
        confirmed,
        blockHeight,
        blockTime,
        confirmationDepth,
        outputMatches,
        doubleSpent,
        errors,
        warnings,
    };
}
