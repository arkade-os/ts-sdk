import { RawWitness, Transaction } from "@scure/btc-signer";

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
