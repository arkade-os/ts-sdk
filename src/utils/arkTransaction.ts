import { DEFAULT_SEQUENCE, Transaction } from "@scure/btc-signer";
import { VirtualCoin } from "../wallet";
import { CLTVMultisigTapscript, decodeTapscript } from "../script/tapscript";
import {
    EncodedVtxoScript,
    scriptFromTapLeafScript,
    TapLeafScript,
    VtxoScript,
} from "../script/base";
import { P2A } from "./anchor";
import { CSVMultisigTapscript } from "../script/tapscript";
import { hex } from "@scure/base";
import { TransactionOutput } from "@scure/btc-signer/psbt";
import { Bytes, sha256x2 } from "@scure/btc-signer/utils";
import { setArkPsbtField, VtxoTaprootTree } from "./unknownFields";

export type ArkTxInput = {
    // the script used to spend the vtxo
    tapLeafScript: TapLeafScript;
    // the script used to spend the checkpoint vtxo, if not provided, fallback to tapLeafScript
    checkpointTapLeafScript?: Bytes;
} & EncodedVtxoScript &
    Pick<VirtualCoin, "txid" | "vout" | "value">;

export type OffchainTx = {
    arkTx: Transaction;
    checkpoints: Transaction[];
};

/**
 * Builds an offchain transaction with checkpoint transactions.
 *
 * Creates one checkpoint transaction per input and a virtual transaction that
 * combines all the checkpoints, sending to the specified outputs. This is the
 * core function for creating Ark transactions.
 *
 * @param inputs - Array of virtual transaction inputs
 * @param outputs - Array of transaction outputs
 * @param serverUnrollScript - Server unroll script for checkpoint transactions
 * @returns Object containing the virtual transaction and checkpoint transactions
 */
export function buildOffchainTx(
    inputs: ArkTxInput[],
    outputs: TransactionOutput[],
    serverUnrollScript: CSVMultisigTapscript.Type
): OffchainTx {
    const checkpoints = inputs.map((input) =>
        buildCheckpointTx(input, serverUnrollScript)
    );

    const arkTx = buildVirtualTx(
        checkpoints.map((c) => c.input),
        outputs
    );

    return {
        arkTx,
        checkpoints: checkpoints.map((c) => c.tx),
    };
}

function buildVirtualTx(inputs: ArkTxInput[], outputs: TransactionOutput[]) {
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
        version: 3,
        allowUnknown: true,
        allowUnknownOutputs: true,
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

        setArkPsbtField(tx, i, VtxoTaprootTree, input.tapTree);
    }

    for (const output of outputs) {
        tx.addOutput(output);
    }

    // add the anchor output
    tx.addOutput(P2A);

    return tx;
}

function buildCheckpointTx(
    vtxo: ArkTxInput,
    serverUnrollScript: CSVMultisigTapscript.Type
): { tx: Transaction; input: ArkTxInput } {
    // create the checkpoint vtxo script from collaborative closure
    const collaborativeClosure = decodeTapscript(
        vtxo.checkpointTapLeafScript ??
            scriptFromTapLeafScript(vtxo.tapLeafScript)
    );

    // create the checkpoint vtxo script combining collaborative closure and server unroll script
    const checkpointVtxoScript = new VtxoScript([
        serverUnrollScript.script,
        collaborativeClosure.script,
    ]);

    // build the checkpoint virtual tx
    const checkpointTx = buildVirtualTx(
        [vtxo],
        [
            {
                amount: BigInt(vtxo.value),
                script: checkpointVtxoScript.pkScript,
            },
        ]
    );

    // get the collaborative leaf proof
    const collaborativeLeafProof = checkpointVtxoScript.findLeaf(
        hex.encode(collaborativeClosure.script)
    );

    // create the checkpoint input that will be used as input of the virtual tx
    const checkpointInput = {
        txid: hex.encode(sha256x2(checkpointTx.toBytes(true)).reverse()),
        vout: 0,
        value: vtxo.value,
        tapLeafScript: collaborativeLeafProof,
        tapTree: checkpointVtxoScript.encode(),
    };

    return {
        tx: checkpointTx,
        input: checkpointInput,
    };
}

const nLocktimeMinSeconds = 500_000_000n;

function isSeconds(locktime: bigint): boolean {
    return locktime >= nLocktimeMinSeconds;
}
