import { hex, base64 } from "@scure/base";
import type { Outpoint } from "../wallet";
import type { OnchainProvider } from "../providers/onchain";
import { ChainTxType } from "../providers/indexer";
import type { ExitDataRepository } from "./exitDataStore";
import { validateExitData } from "./exitDataStore";
import { Transaction } from "../utils/transaction";
import { errorMessage } from "./utils";

export interface SovereignExitStep {
    type: "broadcast" | "wait" | "done";
    txid: string;
    description: string;
}

export interface SovereignExitResult {
    success: boolean;
    steps: SovereignExitStep[];
    finalTxid?: string;
    errors: string[];
}

export async function canSovereignExit(
    vtxoOutpoint: Outpoint,
    exitDataRepo: ExitDataRepository,
    onchain: OnchainProvider
): Promise<{
    canExit: boolean;
    reason?: string;
    exitPath?: string;
    timelockRemaining?: number;
}> {
    const data = await exitDataRepo.getExitData(vtxoOutpoint);
    if (!data) {
        return { canExit: false, reason: "No exit data stored for this VTXO" };
    }

    const validation = validateExitData(data);
    if (!validation.valid) {
        return {
            canExit: false,
            reason: `Invalid exit data: ${validation.errors.join(", ")}`,
        };
    }

    try {
        const txStatus = await onchain.getTxStatus(data.commitmentTxid);
        if (!txStatus.confirmed) {
            return {
                canExit: false,
                reason: "Commitment tx is not confirmed onchain",
            };
        }
    } catch (err) {
        return {
            canExit: false,
            reason: `Failed to check commitment tx: ${errorMessage(err)}`,
        };
    }

    return { canExit: true };
}

/**
 * Broadcasts pre-signed virtual transactions for a sovereign exit.
 *
 * NOTE: This does NOT yet construct the final sweep transaction to claim
 * funds to the user's address, nor does it perform CPFP anchor bumping.
 * Those steps will be added in a future release.
 */
export async function sovereignExit(
    vtxoOutpoint: Outpoint,
    exitDataRepo: ExitDataRepository,
    onchain: OnchainProvider
): Promise<SovereignExitResult> {
    const steps: SovereignExitStep[] = [];
    const errors: string[] = [];

    const data = await exitDataRepo.getExitData(vtxoOutpoint);
    if (!data) {
        return {
            success: false,
            steps,
            errors: ["No exit data stored for this VTXO"],
        };
    }

    const validation = validateExitData(data);
    if (!validation.valid) {
        return {
            success: false,
            steps,
            errors: validation.errors,
        };
    }

    // Walk chain from root (commitment) toward leaf, broadcasting each tx
    const chainTxIds = data.chain
        .filter((c) => c.type !== ChainTxType.COMMITMENT)
        .map((c) => c.txid);

    // Process from root to leaf (reverse since chain is leaf→root)
    for (const txid of [...chainTxIds].reverse()) {
        try {
            const txStatus = await onchain.getTxStatus(txid);
            if (txStatus.confirmed) {
                steps.push({
                    type: "wait",
                    txid,
                    description: `Already confirmed: ${txid}`,
                });
                continue;
            }
        } catch {
            // Not found onchain — needs broadcasting
        }

        const psbt = data.virtualTxs[txid];
        if (!psbt) {
            errors.push(`Missing PSBT for tx ${txid}`);
            return { success: false, steps, errors };
        }

        // Finalize the PSBT and broadcast
        try {
            const tx = Transaction.fromPSBT(base64.decode(psbt));
            const input = tx.getInput(0);

            if (input.tapKeySig) {
                // Tree tx: finalize with key-path witness
                tx.updateInput(0, {
                    finalScriptWitness: [input.tapKeySig],
                });
            } else if (input.tapScriptSig && input.tapScriptSig.length > 0) {
                // Tapscript spend: finalize assembles witness from tapScriptSig + tapLeafScript
                tx.finalize();
            } else {
                // Already finalized or no signatures — try as-is
                tx.finalize();
            }

            const rawHex = hex.encode(tx.toBytes());
            await onchain.broadcastTransaction(rawHex);

            steps.push({
                type: "broadcast",
                txid,
                description: `Broadcast virtual tx: ${txid}`,
            });
        } catch (err) {
            const errMsg = errorMessage(err);
            // "already in mempool" is not a real failure
            if (/already|mempool|duplicate/i.test(errMsg)) {
                steps.push({
                    type: "broadcast",
                    txid,
                    description: `Already in mempool: ${txid}`,
                });
            } else {
                errors.push(`Failed to broadcast tx ${txid}: ${errMsg}`);
                steps.push({
                    type: "broadcast",
                    txid,
                    description: `Broadcast failed: ${txid}`,
                });
            }
        }
    }

    const lastBroadcastTxid =
        [...steps].reverse().find((s) => s.type === "broadcast")?.txid ??
        vtxoOutpoint.txid;

    steps.push({
        type: "done",
        txid: lastBroadcastTxid,
        description:
            "Virtual transactions broadcast complete (final sweep tx not yet implemented)",
    });

    if (errors.length === 0) {
        errors.push("Final sweep transaction is not implemented yet");
    }

    return {
        success: false,
        steps,
        finalTxid: lastBroadcastTxid,
        errors,
    };
}
