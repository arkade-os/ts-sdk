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
import { hex } from "@scure/base";

const ARK_UNKNOWN_KEY_TYPE = 255;

// Constant for condition witness key prefix
export const CONDITION_WITNESS_KEY_PREFIX = new TextEncoder().encode(
    "condition"
);

export const VTXO_TAPROOT_TREE_KEY_PREFIX = new TextEncoder().encode("taptree");

export function addVtxoTaprootTree(
    inIndex: number,
    tx: Transaction,
    tapTree: Uint8Array
): void {
    tx.updateInput(inIndex, {
        unknown: [
            ...(tx.getInput(inIndex)?.unknown ?? []),
            [
                {
                    type: ARK_UNKNOWN_KEY_TYPE,
                    key: VTXO_TAPROOT_TREE_KEY_PREFIX,
                },
                tapTree,
            ],
        ],
    });
}

export function addConditionWitness(
    inIndex: number,
    tx: Transaction,
    witness: Uint8Array[]
): void {
    const witnessBytes = RawWitness.encode(witness);

    tx.updateInput(inIndex, {
        unknown: [
            ...(tx.getInput(inIndex)?.unknown ?? []),
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
    let lockTime = 0n;
    for (const input of inputs) {
        const tapscript = decodeTapscript(
            scriptFromTapLeafScript(input.tapLeafScript)
        );
        if (CLTVMultisigTapscript.is(tapscript)) {
            if (lockTime !== 0n) {
                // if a locktime is already set, check if the new locktime is in the same unit
                if (
                    isSeconds(lockTime) !==
                    isSeconds(tapscript.params.absoluteTimelock)
                ) {
                    throw new Error("cannot mix seconds and blocks locktime");
                }
            }

            if (tapscript.params.absoluteTimelock > lockTime) {
                lockTime = tapscript.params.absoluteTimelock;
            }
        }
    }

    const tx = new Transaction({
        allowUnknown: true,
        lockTime: Number(lockTime),
    });

    for (const [i, input] of inputs.entries()) {
        tx.addInput({
            txid: input.txid,
            index: input.vout,
            sequence: lockTime ? DEFAULT_SEQUENCE - 1 : undefined,
            witnessUtxo: {
                script: VtxoScript.decode(input.tapTree).pkScript,
                amount: BigInt(input.value),
            },
            tapLeafScript: [input.tapLeafScript],
        });

        // add BIP371 encoded taproot tree to the unknown key field
        addVtxoTaprootTree(i, tx, input.tapTree);
    }

    for (const output of outputs) {
        tx.addOutput({
            amount: output.amount,
            script: ArkAddress.decode(output.address).pkScript,
        });
    }

    return tx;
}

const nLocktimeMinSeconds = 500_000_000n;

function isSeconds(locktime: bigint): boolean {
    return locktime >= nLocktimeMinSeconds;
}
