import { Transaction } from "./utils/transaction";
import {
    TransactionInputUpdate,
    TransactionOutput,
} from "@scure/btc-signer/psbt.js";
import { P2A } from "./utils/anchor";

/**
 * Build a forfeit transaction that spends the provided inputs to a single forfeit output.
 *
 * @param inputs - Inputs to include in the forfeit transaction
 * @param forfeitPkScript - ScriptPubKey for the forfeit output
 * @param txLocktime - Optional locktime to apply to the transaction
 */
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

/**
 * Build a forfeit transaction using an explicit output descriptor (used for delegated renewals)
 *
 * @param inputs - Inputs to include in the forfeit transaction
 * @param output - Primary transaction output
 * @param txLocktime - Optional locktime to apply to the transaction
 */
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
