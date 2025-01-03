import { SigHash, Transaction } from "@scure/btc-signer";
import { TransactionInputUpdate } from "@scure/btc-signer/psbt";

type Outpoint = Pick<TransactionInputUpdate, "txid" | "index">;
type WitnessUtxo = {
    script: Uint8Array;
    amount: bigint;
};

interface ForfeitTxParams {
    connectorTx: Transaction;
    vtxoInput: Outpoint;
    vtxoAmount: bigint;
    connectorAmount: bigint;
    feeAmount: bigint;
    vtxoScript: Uint8Array;
    serverScript: Uint8Array;
    txLocktime?: number;
}

export function buildForfeitTxs({
    connectorTx,
    vtxoInput,
    vtxoAmount,
    connectorAmount,
    feeAmount,
    vtxoScript,
    serverScript,
    txLocktime,
}: ForfeitTxParams): Transaction[] {
    const [connectors, prevouts] = getConnectorInputs(
        connectorTx,
        connectorAmount
    );
    const forfeitTxs: Transaction[] = [];

    for (let i = 0; i < connectors.length; i++) {
        const connectorInput = connectors[i];
        const connectorPrevout = prevouts[i];

        // Create new transaction
        const tx = new Transaction({
            version: 2,
            lockTime: txLocktime,
        });

        // Add connector input
        tx.addInput({
            ...connectorInput,
            witnessUtxo: connectorPrevout,
            sequence: 0xffffffff, // MAX_SEQUENCE
        });

        // Add VTXO input
        tx.addInput({
            ...vtxoInput,
            witnessUtxo: {
                script: vtxoScript,
                amount: vtxoAmount,
            },
            sequence: txLocktime ? 0xfffffffe : 0xffffffff, // MAX_SEQUENCE - 1 if locktime is set
            sighashType: SigHash.DEFAULT,
        });

        // Add main output to server
        tx.addOutput({
            script: serverScript,
            amount: vtxoAmount + connectorAmount - feeAmount,
        });

        forfeitTxs.push(tx);
    }

    return forfeitTxs;
}

// extract outpoints and witness utxos from a connector transaction
function getConnectorInputs(
    tx: Transaction,
    connectorAmount: bigint
): [Outpoint[], WitnessUtxo[]] {
    const outpoints: Outpoint[] = [];
    const witnessUtxos: WitnessUtxo[] = [];
    const txid = tx.id;

    for (let index = 0; index < tx.outputsLength; index++) {
        const output = tx.getOutput(index);
        if (output.amount === connectorAmount) {
            outpoints.push({
                txid,
                index,
            });

            if (!output.script) {
                throw new Error("Output script is undefined");
            }

            witnessUtxos.push({
                script: output.script,
                amount: output.amount,
            });
        }
    }

    return [outpoints, witnessUtxos];
}
