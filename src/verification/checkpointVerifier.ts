import type { ChainTx } from "../providers/indexer";
import { ChainTxType } from "../providers/indexer";
import type { RelativeTimelock } from "../script/tapscript";

export interface CheckpointVerificationResult {
    txid: string;
    valid: boolean;
    errors: string[];
    warnings: string[];
}

export interface CheckpointTimelockResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

export function verifyCheckpointTransactions(
    chain: ChainTx[],
    sweepInterval: RelativeTimelock,
    nowMs: number = Date.now()
): CheckpointVerificationResult[] {
    const entriesByTxid = new Map(chain.map((entry) => [entry.txid, entry]));
    const checkpoints = chain.filter(
        (entry) => entry.type === ChainTxType.CHECKPOINT
    );

    return checkpoints.map((checkpoint) => {
        const errors: string[] = [];
        const warnings: string[] = [];

        if (!checkpoint.spends || checkpoint.spends.length === 0) {
            errors.push("Checkpoint has no parent references");
        } else if (checkpoint.spends.length > 1) {
            errors.push("Checkpoint references multiple parents");
        } else {
            const parentTxid = checkpoint.spends[0];
            if (!entriesByTxid.has(parentTxid)) {
                errors.push(
                    `Checkpoint parent ${parentTxid} is missing from the chain`
                );
            }
        }

        const children = chain.filter(
            (entry) =>
                entry.type !== ChainTxType.CHECKPOINT &&
                (entry.spends ?? []).includes(checkpoint.txid)
        );

        if (children.length === 0) {
            errors.push(
                "Checkpoint is not integrated into the DAG by any child transaction"
            );
        }

        const timelock = verifyCheckpointTimelocks(
            checkpoint,
            sweepInterval,
            nowMs
        );
        errors.push(...timelock.errors);
        warnings.push(...timelock.warnings);

        return {
            txid: checkpoint.txid,
            valid: errors.length === 0,
            errors,
            warnings,
        };
    });
}

export function verifyCheckpointTimelocks(
    checkpoint: ChainTx,
    sweepInterval: RelativeTimelock,
    nowMs: number = Date.now()
): CheckpointTimelockResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!checkpoint.expiresAt) {
        warnings.push(
            `Checkpoint ${checkpoint.txid} is missing expiry metadata; cannot validate ${sweepInterval.type} sweep delay timing`
        );
        return { valid: true, errors, warnings };
    }

    const expiresAtMs = new Date(checkpoint.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs)) {
        errors.push(
            `Checkpoint ${checkpoint.txid} has invalid expiry timestamp ${checkpoint.expiresAt}`
        );
        return { valid: false, errors, warnings };
    }

    if (expiresAtMs < nowMs) {
        warnings.push(
            `Checkpoint ${checkpoint.txid} has expired at ${checkpoint.expiresAt}`
        );
    }

    if (sweepInterval.value <= 0n) {
        warnings.push(
            `Sweep delay ${sweepInterval.value.toString()} is non-positive; checkpoint timing could not be meaningfully validated`
        );
    }

    return { valid: errors.length === 0, errors, warnings };
}
