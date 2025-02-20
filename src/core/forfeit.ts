import { SigHash, Transaction } from "@scure/btc-signer";
import { Outpoint } from "../types/wallet";

interface ForfeitTxParams {
    connectorInput: Outpoint;
    vtxoInput: Outpoint;
    vtxoAmount: bigint;
    connectorAmount: bigint;
    feeAmount: bigint;
    vtxoScript: Uint8Array;
    connectorScript: Uint8Array;
    serverScript: Uint8Array;
    txLocktime?: number;
}

export function buildForfeitTx({
    connectorInput,
    vtxoInput,
    vtxoAmount,
    connectorAmount,
    feeAmount,
    vtxoScript,
    connectorScript,
    serverScript,
    txLocktime,
}: ForfeitTxParams): Transaction {
    const tx = new Transaction({
        version: 2,
        lockTime: txLocktime,
    });

    // Add connector input
    tx.addInput({
        txid: connectorInput.txid,
        index: connectorInput.vout,
        witnessUtxo: {
            script: connectorScript,
            amount: connectorAmount,
        },
        sequence: 0xffffffff,
    });

    // Add VTXO input
    tx.addInput({
        txid: vtxoInput.txid,
        index: vtxoInput.vout,
        witnessUtxo: {
            script: vtxoScript,
            amount: vtxoAmount,
        },
        sequence: txLocktime ? 0xfffffffe : 0xffffffff, // MAX_SEQUENCE - 1 if locktime is set
        sighashType: SigHash.DEFAULT,
    });

    const amount =
        BigInt(vtxoAmount) + BigInt(connectorAmount) - BigInt(feeAmount);

    // Add main output to server
    tx.addOutput({
        script: serverScript,
        amount,
    });

    return tx;
}
