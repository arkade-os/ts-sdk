import { hex, base64 } from "@scure/base";
import { Address, SigHash } from "@scure/btc-signer";
import type { Outpoint } from "../wallet";
import type { OnchainProvider } from "../providers/onchain";
import { ChainTxType } from "../providers/indexer";
import type { ExitClaimInput, ExitDataRepository } from "./exitDataStore";
import { validateExitData } from "./exitDataStore";
import { Transaction } from "../utils/transaction";
import { errorMessage } from "./utils";
import type { Identity } from "../identity";
import type { Network } from "../networks";
import { VtxoScript } from "../script/base";
import {
    CSVMultisigTapscript,
    ConditionCSVMultisigTapscript,
} from "../script/tapscript";

export interface SovereignExitOptions {
    identity?: Identity;
    outputAddress?: string;
    network?: Network;
}

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

export async function sovereignExit(
    vtxoOutpoint: Outpoint,
    exitDataRepo: ExitDataRepository,
    onchain: OnchainProvider,
    options?: SovereignExitOptions
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
            let sawTapKeySig = false;
            let sawTapScriptSig = false;

            for (
                let inputIndex = 0;
                inputIndex < tx.inputsLength;
                inputIndex++
            ) {
                const input = tx.getInput(inputIndex);
                if (input.tapKeySig) {
                    tx.updateInput(inputIndex, {
                        finalScriptWitness: [input.tapKeySig],
                    });
                    sawTapKeySig = true;
                }

                if (input.tapScriptSig && input.tapScriptSig.length > 0) {
                    sawTapScriptSig = true;
                }
            }

            if (sawTapScriptSig || !sawTapKeySig) {
                // Finalize remaining script-path or as-yet-unfinalized inputs.
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

    let finalTxid = chainTxIds[0] ?? vtxoOutpoint.txid;

    if (options?.identity || options?.outputAddress || options?.network) {
        if (!options.identity || !options.outputAddress || !options.network) {
            errors.push(
                "Final claim requires identity, outputAddress, and network"
            );
        } else if (!data.claimInput) {
            errors.push(
                "Stored exit data does not include claim input details for the final claim"
            );
        } else {
            const claim = await buildFinalClaimTransaction(
                data.claimInput,
                options.outputAddress,
                options.network,
                options.identity,
                onchain
            );

            if (claim.waitStep) {
                steps.push(claim.waitStep);
                errors.push(claim.waitStep.description);
            } else if (claim.tx) {
                try {
                    await onchain.broadcastTransaction(claim.tx.hex);
                    finalTxid = claim.tx.id;
                    steps.push({
                        type: "broadcast",
                        txid: claim.tx.id,
                        description: `Broadcast final claim tx: ${claim.tx.id}`,
                    });
                } catch (err) {
                    const errMsg = errorMessage(err);
                    if (/already|mempool|duplicate/i.test(errMsg)) {
                        finalTxid = claim.tx.id;
                        steps.push({
                            type: "broadcast",
                            txid: claim.tx.id,
                            description: `Final claim already in mempool: ${claim.tx.id}`,
                        });
                    } else {
                        errors.push(
                            `Failed to broadcast final claim tx ${claim.tx.id}: ${errMsg}`
                        );
                    }
                }
            }
        }
    }

    steps.push({
        type: "done",
        txid: finalTxid,
        description: "Sovereign exit transaction sequence complete",
    });

    return {
        success: errors.length === 0,
        steps,
        finalTxid,
        errors,
    };
}

async function buildFinalClaimTransaction(
    claimInput: ExitClaimInput,
    outputAddress: string,
    network: Network,
    identity: Identity,
    onchain: OnchainProvider
): Promise<{
    tx?: Transaction;
    waitStep?: SovereignExitStep;
}> {
    const txStatus = await onchain.getTxStatus(claimInput.txid);
    if (!txStatus.confirmed) {
        return {
            waitStep: {
                type: "wait",
                txid: claimInput.txid,
                description: `Final claim unavailable until ${claimInput.txid} is confirmed`,
            },
        };
    }

    const tapTree = hex.decode(claimInput.tapTree);
    const vtxoScript = VtxoScript.decode(tapTree);
    const chainTip = await onchain.getChainTip();
    const exit = availableExitPath(
        { height: txStatus.blockHeight, time: txStatus.blockTime },
        { height: chainTip.height, time: chainTip.time },
        vtxoScript
    );

    if (!exit) {
        return {
            waitStep: {
                type: "wait",
                txid: claimInput.txid,
                description: `Final claim timelock is not yet spendable for ${claimInput.txid}`,
            },
        };
    }

    const spendingLeaf = vtxoScript.findLeaf(hex.encode(exit.script));
    const tx = new Transaction({ version: 2 });
    tx.addInput({
        txid: hex.decode(claimInput.txid),
        index: claimInput.vout,
        tapLeafScript: [spendingLeaf],
        sequence: 0xffffffff - 1,
        witnessUtxo: {
            amount: BigInt(claimInput.value),
            script: vtxoScript.pkScript,
        },
        sighashType: SigHash.DEFAULT,
    });

    let feeRate = await onchain.getFeeRate();
    if (!feeRate || feeRate < 1) {
        feeRate = 1;
    }

    const fee = BigInt(Math.max(200, Math.ceil(feeRate * 200)));
    const sendAmount = BigInt(claimInput.value) - fee;
    if (sendAmount <= 0n) {
        throw new Error("Final claim amount is not sufficient to cover fees");
    }

    Address(network).decode(outputAddress);
    tx.addOutputAddress(outputAddress, sendAmount, network);

    const signedTx = await identity.sign(tx);
    signedTx.finalize();

    return { tx: signedTx };
}

function availableExitPath(
    confirmedAt: { height: number; time: number },
    current: { height: number; time: number },
    vtxoScript: VtxoScript
): CSVMultisigTapscript.Type | ConditionCSVMultisigTapscript.Type | undefined {
    for (const exit of vtxoScript.exitPaths()) {
        if (exit.params.timelock.type === "blocks") {
            if (
                current.height >=
                confirmedAt.height + Number(exit.params.timelock.value)
            ) {
                return exit;
            }
            continue;
        }

        if (
            current.time >=
            confirmedAt.time + Number(exit.params.timelock.value)
        ) {
            return exit;
        }
    }

    return undefined;
}
