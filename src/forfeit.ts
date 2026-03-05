import { Transaction } from "./utils/transaction";
import {
    TransactionInputUpdate,
    TransactionOutput,
} from "@scure/btc-signer/psbt.js";
import { P2A } from "./utils/anchor";

export function buildForfeitTx(
    inputs: TransactionInputUpdate[],
    forfeitPkScript: Uint8Array,
    txLocktime?: number,
    additionalOutputs?: TransactionOutput[]
): Transaction {
    let amount = 0n;
    for (const input of inputs) {
        if (!input.witnessUtxo) {
            throw new Error("input needs witness utxo");
        }
        amount += input.witnessUtxo.amount;
    }

    return buildForfeitTxWithOutput(
        inputs,
        {
            script: forfeitPkScript,
            amount,
        },
        txLocktime,
        additionalOutputs
    );
}

export function buildForfeitTxWithOutput(
    inputs: TransactionInputUpdate[],
    output: TransactionOutput,
    txLocktime?: number,
    additionalOutputs?: TransactionOutput[]
): Transaction {
    const tx = new Transaction({
        version: 3,
        lockTime: txLocktime,
    });
    for (const input of inputs) {
        tx.addInput(input);
    }
    tx.addOutput(output);
    if (additionalOutputs) {
        for (const out of additionalOutputs) {
            tx.addOutput(out);
        }
    }
    tx.addOutput(P2A);
    return tx;
}
