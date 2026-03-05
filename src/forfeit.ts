import { Transaction } from "./utils/transaction";
import {
    TransactionInputUpdate,
    TransactionOutput,
} from "@scure/btc-signer/psbt.js";
import { P2A } from "./utils/anchor";

export function buildForfeitTx(
    inputs: TransactionInputUpdate[],
    forfeitPkScript: Uint8Array,
    txLocktime?: number
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
        txLocktime
    );
}

export function buildForfeitTxWithOutput(
    inputs: TransactionInputUpdate[],
    output: TransactionOutput,
    txLocktime?: number
): Transaction {
    const tx = new Transaction({
        version: 3,
        lockTime: txLocktime,
    });
    for (const input of inputs) {
        tx.addInput(input);
    }
    tx.addOutput(output);
    tx.addOutput(P2A);
    return tx;
}
