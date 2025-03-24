import { DEFAULT_SEQUENCE, RawWitness, Transaction } from "@scure/btc-signer";
import { VirtualCoin } from "../wallet";
import { Output } from "../providers/ark";
import { CLTVMultisigTapscript, decodeTapscript } from "../script/tapscript";
import {
    EncodedVtxoScript,
    scriptFromTapLeafScript,
    TapLeafScript,
    VtxoScript,
} from "../script/base";
import { ArkAddress } from "../script/address";

const ARK_UNKNOWN_KEY_TYPE = 255;

// Constant for condition witness key prefix
export const CONDITION_WITNESS_KEY_PREFIX = new TextEncoder().encode(
    "condition"
);

export function addConditionWitness(
    inIndex: number,
    tx: Transaction,
    witness: Uint8Array[]
): void {
    const witnessBytes = RawWitness.encode(witness);

    tx.updateInput(inIndex, {
        unknown: [
            [
                {
                    type: ARK_UNKNOWN_KEY_TYPE,
                    key: CONDITION_WITNESS_KEY_PREFIX,
                },
                witnessBytes,
            ],
        ],
    });
}

export function createVirtualTx(
    inputs: ({ tapLeafScript: TapLeafScript } & EncodedVtxoScript &
        Pick<VirtualCoin, "txid" | "vout" | "value">)[],
    outputs: Output[]
) {
    let lockTime: number | undefined;
    for (const input of inputs) {
        const tapscript = decodeTapscript(
            scriptFromTapLeafScript(input.tapLeafScript)
        );
        if (CLTVMultisigTapscript.is(tapscript)) {
            lockTime = Number(tapscript.params.absoluteTimelock);
        }
    }

    const tx = new Transaction({
        allowUnknown: true,
        lockTime,
    });

    for (const input of inputs) {
        tx.addInput({
            txid: input.txid,
            index: input.vout,
            sequence: lockTime ? DEFAULT_SEQUENCE - 1 : undefined,
            witnessUtxo: {
                script: VtxoScript.decode(input.scripts).pkScript,
                amount: BigInt(input.value),
            },
            tapLeafScript: [input.tapLeafScript],
        });
    }

    for (const output of outputs) {
        tx.addOutput({
            amount: output.amount,
            script: ArkAddress.decode(output.address).pkScript,
        });
    }

    return tx;
}
