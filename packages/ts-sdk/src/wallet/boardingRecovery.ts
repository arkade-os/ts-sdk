import { p2tr } from "@scure/btc-signer";
import { equalBytes } from "@scure/btc-signer/utils.js";
import type { Identity } from "../identity";
import type { Network } from "../networks";
import type { OnchainProvider } from "../providers/onchain";
import { createBoardingProgramScript, type BoardingProgram } from "../script/boarding";
import { getSequence, scriptFromTapLeafScript } from "../script/base";
import type { RelativeTimelock } from "../script/tapscript";
import type { ExtendedCoin } from ".";
import { hasBoardingTxExpired } from "../utils/arkTransaction";
import { Transaction } from "../utils/transaction";
import { TxWeightEstimator } from "../utils/txSizeEstimator";

export interface RecoverBoardingProgramParams {
    program: BoardingProgram;
    operatorPubKey: Uint8Array;
    boardingTimelock: RelativeTimelock;
    inputs: readonly ExtendedCoin[];
    recoveryIdentity: Identity;
    destination: string;
    network: Network;
    onchainProvider: OnchainProvider;
    maxFeeRateSatVb: number;
    absoluteFeeCapSats: bigint;
    dustAmount?: bigint;
}

/**
 * Sweep matured outputs from the exact named boarding program to the
 * recovery identity's ordinary Taproot address. The supplied identity is
 * deliberately one-shot; callers should obtain it only after explicit user
 * authorization and discard it when this promise settles.
 */
export async function recoverBoardingProgram(
    params: RecoverBoardingProgramParams,
): Promise<string> {
    if (params.inputs.length === 0) {
        throw new Error("No boarding inputs to recover");
    }
    if (!Number.isFinite(params.maxFeeRateSatVb) || params.maxFeeRateSatVb <= 0) {
        throw new Error("maxFeeRateSatVb must be a positive finite number");
    }
    if (params.absoluteFeeCapSats <= 0n) {
        throw new Error("absoluteFeeCapSats must be positive");
    }

    const recoveryPubKey = await params.recoveryIdentity.xOnlyPublicKey();
    if (!equalBytes(recoveryPubKey, params.program.recoveryPubKey)) {
        throw new Error("recovery identity does not match the boarding program");
    }

    const controlledDestination = p2tr(recoveryPubKey, undefined, params.network).address;
    if (!controlledDestination || params.destination !== controlledDestination) {
        throw new Error("recovery destination is not controlled by the recovery identity");
    }

    const script = createBoardingProgramScript(
        params.program,
        params.operatorPubKey,
        params.boardingTimelock,
    );
    const encodedScript = script.encode();
    const exitLeaf = script.exit();
    const chainTip =
        params.boardingTimelock.type === "blocks"
            ? await params.onchainProvider.getChainTip()
            : undefined;

    for (const input of params.inputs) {
        if (!equalBytes(input.tapTree, encodedScript)) {
            throw new Error(`boarding input ${input.txid}:${input.vout} is not from this program`);
        }
        if (!input.status.confirmed) {
            throw new Error(`boarding input ${input.txid}:${input.vout} is not confirmed`);
        }
        if (!hasBoardingTxExpired(input, params.boardingTimelock, chainTip?.height)) {
            throw new Error(`boarding input ${input.txid}:${input.vout} is not mature`);
        }
    }

    const feeRate = (await params.onchainProvider.getFeeRate()) ?? 1;
    if (!Number.isFinite(feeRate) || feeRate <= 0 || feeRate > params.maxFeeRateSatVb) {
        throw new Error("boarding recovery fee rate exceeds the approved maximum");
    }
    const leafScriptSize = scriptFromTapLeafScript(exitLeaf).length;
    const controlPathSize = exitLeaf[0].merklePath.length * 32;
    const estimator = TxWeightEstimator.create();
    for (const _ of params.inputs) {
        estimator.addTapscriptInput(64, leafScriptSize, controlPathSize);
    }
    estimator.addOutputAddress(params.destination, params.network);

    const fee = BigInt(Math.ceil(Number(estimator.vsize().value) * feeRate));
    if (fee > params.absoluteFeeCapSats) {
        throw new Error("boarding recovery fee exceeds the approved absolute cap");
    }
    const outputAmount = params.inputs.reduce((sum, input) => sum + BigInt(input.value), 0n) - fee;
    const dustAmount = params.dustAmount ?? 330n;
    if (outputAmount < dustAmount) {
        throw new Error("boarding recovery output is below dust after fees");
    }

    const tx = new Transaction();
    for (const input of params.inputs) {
        tx.addInput({
            txid: input.txid,
            index: input.vout,
            witnessUtxo: {
                script: script.pkScript,
                amount: BigInt(input.value),
            },
            tapLeafScript: [exitLeaf],
            sequence: getSequence(exitLeaf),
        });
    }
    tx.addOutputAddress(params.destination, outputAmount, params.network);

    const signed = await params.recoveryIdentity.sign(
        tx,
        params.inputs.map((_, index) => index),
    );
    signed.finalize();
    return params.onchainProvider.broadcastTransaction(signed.hex);
}
