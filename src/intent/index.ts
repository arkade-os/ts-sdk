import { OP, Transaction, Script, SigHash } from "@scure/btc-signer";
import { TransactionInput, TransactionOutput } from "@scure/btc-signer/psbt.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { Bytes } from "@scure/btc-signer/utils.js";

/**
 * Intent proof implementation for Bitcoin message signing.
 *
 * Intent proof defines a standard for signing Bitcoin messages as well as proving
 * ownership of coins. This namespace provides utilities for creating and
 * validating Intent proof.
 *
 * it is greatly inspired by BIP322.
 * @see https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki
 *
 * @example
 * ```typescript
 * // Create a Intent proof
 * const proof = Intent.create(
 *   "Hello Bitcoin!",
 *   [input],
 *   [output]
 * );
 *
 * // Sign the proof
 * const signedProof = await identity.sign(proof);
 *
 */
export namespace Intent {
    // Intent proof is a special invalid psbt containing the inputs to prove ownership
    // signing the proof means signing the psbt as a regular transaction
    export type Proof = Transaction;

    /**
     * Creates a new Intent proof unsigned transaction.
     *
     * This function constructs a special transaction that can be signed to prove
     * ownership of VTXOs and UTXOs. The proof includes the message to be
     * signed and the inputs/outputs that demonstrate ownership.
     *
     * @param message - The Intent message to be signed
     * @param inputs - Array of transaction inputs to prove ownership of
     * @param outputs - Optional array of transaction outputs
     * @returns An unsigned Intent proof transaction
     */
    export function create(
        message: string,
        inputs: TransactionInput[],
        outputs: TransactionOutput[] = []
    ): Proof {
        if (inputs.length == 0)
            throw new Error("intent proof requires at least one input");
        if (!validateInputs(inputs)) throw new Error("invalid inputs");
        if (!validateOutputs(outputs)) throw new Error("invalid outputs");

        // create the initial transaction to spend
        const toSpend = craftToSpendTx(message, inputs[0].witnessUtxo.script);

        // create the transaction to sign
        return craftToSignTx(toSpend, inputs, outputs);
    }
}

const OP_RETURN_EMPTY_PKSCRIPT = new Uint8Array([OP.RETURN]);
const ZERO_32 = new Uint8Array(32).fill(0);
const MAX_INDEX = 0xffffffff;
const TAG_INTENT_PROOF = "ark-intent-proof-message";

type ValidatedTxInput = TransactionInput & {
    witnessUtxo: { script: Uint8Array; amount: bigint };
    index: number;
    txid: Bytes;
};

type ValidatedTxOutput = TransactionOutput & {
    amount: bigint;
    script: Uint8Array;
};

function validateInput(input: TransactionInput): input is ValidatedTxInput {
    if (input.index === undefined)
        throw new Error("intent proof input requires index");
    if (input.txid === undefined)
        throw new Error("intent proof input requires txid");
    if (input.witnessUtxo === undefined)
        throw new Error("intent proof input requires witness utxo");
    return true;
}

function validateInputs(
    inputs: TransactionInput[]
): inputs is ValidatedTxInput[] {
    inputs.forEach(validateInput);
    return true;
}

function validateOutput(
    output: TransactionOutput
): output is ValidatedTxOutput {
    if (output.amount === undefined)
        throw new Error("intent proof output requires amount");
    if (output.script === undefined)
        throw new Error("intent proof output requires script");
    return true;
}

function validateOutputs(
    outputs: TransactionOutput[]
): outputs is ValidatedTxOutput[] {
    outputs.forEach(validateOutput);
    return true;
}

// craftToSpendTx creates the initial transaction that will be spent in the proof
function craftToSpendTx(message: string, pkScript: Uint8Array): Transaction {
    const messageHash = hashMessage(message);
    const tx = new Transaction({
        version: 0,
        allowUnknownOutputs: true,
        allowUnknown: true,
        allowUnknownInputs: true,
    });

    // add input with zero hash and max index
    tx.addInput({
        txid: ZERO_32, // zero hash
        index: MAX_INDEX,
        sequence: 0,
    });

    // add output with zero value and provided pkScript
    tx.addOutput({
        amount: 0n,
        script: pkScript,
    });

    tx.updateInput(0, {
        finalScriptSig: Script.encode(["OP_0", messageHash]),
    });

    return tx;
}

// craftToSignTx creates the transaction that will be signed for the proof
function craftToSignTx(
    toSpend: Transaction,
    inputs: ValidatedTxInput[],
    outputs: ValidatedTxOutput[]
): Transaction {
    const firstInput = inputs[0];

    const tx = new Transaction({
        version: 2,
        allowUnknownOutputs: outputs.length === 0,
        allowUnknown: true,
        allowUnknownInputs: true,
        lockTime: 0,
    });

    // add the first "toSpend" input
    tx.addInput({
        ...firstInput,
        txid: toSpend.id,
        index: 0,
        witnessUtxo: {
            script: firstInput.witnessUtxo.script,
            amount: 0n,
        },
        sighashType: SigHash.ALL,
    });

    // add other inputs
    for (const [i, input] of inputs.entries()) {
        tx.addInput({
            ...input,
            sighashType: SigHash.ALL,
        });

        if (input.unknown?.length) {
            tx.updateInput(i + 1, {
                unknown: input.unknown,
            });
        }
    }

    // add the special OP_RETURN output if no outputs are provided
    if (outputs.length === 0) {
        outputs = [
            {
                amount: 0n,
                script: OP_RETURN_EMPTY_PKSCRIPT,
            },
        ];
    }

    for (const output of outputs) {
        tx.addOutput({
            amount: output.amount,
            script: output.script,
        });
    }

    return tx;
}

function hashMessage(message: string): Uint8Array {
    return schnorr.utils.taggedHash(
        TAG_INTENT_PROOF,
        new TextEncoder().encode(message)
    );
}
