import { SigHash, TaprootControlBlock } from "@scure/btc-signer";
import { PathSelection } from "../../contracts/types";
import { Identity } from "../../identity";
import { Network } from "../../networks";
import { scriptFromTapLeafScript } from "../../script/base";
import { Transaction } from "../../utils/transaction";
import { TxWeightEstimator } from "../../utils/txSizeEstimator";
import { DUST_AMOUNT } from "../utils";

export type SweepVtxo = { txid: string; vout: number; value: number; pkScript: Uint8Array };

/** Witness bytes the extra (condition) items add on top of the signature. */
function extraWitnessSize(path: PathSelection): number {
    return (path.extraWitness ?? []).reduce((sum, item) => sum + 1 + item.length, 0);
}

/** Fee for a single-input sweep of `path` to `outputAddress` at `feeRate`. */
export function sweepFeeFor(
    path: PathSelection,
    outputAddress: string,
    network: Network,
    feeRate: number,
): number {
    const [controlBlock, scriptWithVersion] = path.leaf;
    const estimator = TxWeightEstimator.create()
        .addTapscriptInput(
            64 + extraWitnessSize(path),
            scriptWithVersion.length,
            TaprootControlBlock.encode(controlBlock).length,
        )
        .addOutputAddress(outputAddress, network);
    return Number(estimator.vsize().fee(BigInt(Math.ceil(feeRate))));
}

/**
 * Build, sign, and finalize the CSV sweep for one VTXO.
 *
 * BIP-68 makes the pre-signed tx valid `sequence` after the VTXO tx
 * confirms — signing now and broadcasting later is safe by consensus.
 *
 * Condition paths (extraWitness) are finalized manually: the condition
 * script is the FIRST fragment of the leaf (ConditionCSVMultisigTapscript
 * layout), so its arguments sit on TOP of the initial stack — i.e. LAST in
 * the witness array, right before script and control block:
 * `[sig, ...extraWitness, script, controlBlock]`.
 */
export async function buildSignedSweep(params: {
    vtxo: SweepVtxo;
    path: PathSelection;
    outputAddress: string;
    feeRate: number;
    network: Network;
    identity: Identity;
}): Promise<{ tx: Transaction; fee: number }> {
    const { vtxo, path, outputAddress, feeRate, network, identity } = params;

    const fee = sweepFeeFor(path, outputAddress, network, feeRate);
    const sendAmount = BigInt(vtxo.value) - BigInt(fee);
    if (sendAmount < BigInt(DUST_AMOUNT)) {
        throw new Error(
            `uneconomic vtxo ${vtxo.txid}:${vtxo.vout}: value ${vtxo.value} - fee ${fee} < dust`,
        );
    }

    const tx = new Transaction({ version: 2 });
    tx.addInput({
        txid: vtxo.txid,
        index: vtxo.vout,
        tapLeafScript: [path.leaf],
        sequence: path.sequence,
        witnessUtxo: { amount: BigInt(vtxo.value), script: vtxo.pkScript },
        sighashType: SigHash.DEFAULT,
    });
    tx.addOutputAddress(outputAddress, sendAmount, network);

    const signed = await identity.sign(tx);

    if (!path.extraWitness || path.extraWitness.length === 0) {
        signed.finalize(); // proven path (prepareUnrollTransaction does this)
        return { tx: signed, fee };
    }

    // Manual finalization with condition witness.
    const input = signed.getInput(0);
    const tapScriptSig = input.tapScriptSig;
    if (!tapScriptSig || tapScriptSig.length === 0) {
        throw new Error("exit path requires additional signers");
    }
    const [controlBlock] = path.leaf;
    signed.updateInput(0, {
        finalScriptWitness: [
            tapScriptSig[0][1],
            ...path.extraWitness,
            scriptFromTapLeafScript(path.leaf),
            TaprootControlBlock.encode(controlBlock),
        ],
    });
    return { tx: signed, fee };
}
