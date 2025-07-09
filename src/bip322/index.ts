import { OP, Transaction, Script, SigHash } from "@scure/btc-signer";
import { TransactionInput, TransactionOutput } from "@scure/btc-signer/psbt";
import {
    ErrMissingData,
    ErrMissingInputs,
    ErrMissingWitnessUtxo,
} from "./errors";
import { schnorr } from "@noble/curves/secp256k1";
import { Bytes } from "@scure/btc-signer/utils";
import { base64 } from "@scure/base";

/**
 * BIP-322 signature implementation for Bitcoin message signing.
 *
 * BIP-322 defines a standard for signing Bitcoin messages as well as proving
 * ownership of coins. This namespace provides utilities for creating and
 * validating BIP-322.
 *
 * @see https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki
 *
 * @example
 * ```typescript
 * // Create a BIP-322 proof
 * const proof = BIP322.create(
 *   "Hello Bitcoin!",
 *   [input],
 *   [output]
 * );
 *
 * // Sign the proof
 * const signedProof = await identity.sign(proof);
 *
 * // Extract the signature
 * const signature = BIP322.signature(signedProof);
 * ```
 */
export namespace BIP322 {
    // BIP0322 full proof of funds is a special invalid psbt containing the inputs to prove ownership
    // signing the proof means signing the psbt as a regular transaction
    export type FullProof = Transaction;

    // a BIP322 Signature is the raw FullProof transaction signed and finalized
    // BIP322 signatures are base64 encoded to avoid confusion with real signed transactions
    export type Signature = string;

    /**
     * Creates a new BIP-322 "full" proof of funds unsigned transaction.
     *
     * This function constructs a special transaction that can be signed to prove
     * ownership of VTXOs and UTXOs. The proof includes the message to be
     * signed and the inputs/outputs that demonstrate ownership.
     *
     * @param message - The BIP-322 message to be signed
     * @param inputs - Array of transaction inputs to prove ownership of
     * @param outputs - Optional array of transaction outputs
     * @returns An unsigned BIP-322 proof transaction
     */
    export function create(
        message: string,
        inputs: TransactionInput[],
        outputs: TransactionOutput[] = []
    ): FullProof {
        if (inputs.length == 0) throw ErrMissingInputs;
        if (!validateInputs(inputs)) throw ErrMissingData;
        if (!validateOutputs(outputs)) throw ErrMissingData;

        // create the initial transaction to spend
        const toSpend = craftToSpendTx(message, inputs[0].witnessUtxo.script);

        // create the transaction to sign
        return craftToSignTx(toSpend, inputs, outputs);
    }

    /**
     * Finalizes and extracts the FullProof transaction into a BIP-322 signature.
     *
     * This function takes a signed proof transaction and converts it into a
     * base64-encoded signature string. If the proof's inputs have special
     * spending conditions, a custom finalizer can be provided.
     *
     * @param signedProof - The signed BIP-322 proof transaction
     * @param finalizer - Optional custom finalizer function
     * @returns Base64-encoded BIP-322 signature
     */
    export function signature(
        signedProof: FullProof,
        finalizer = (tx: FullProof) => tx.finalize()
    ): Signature {
        finalizer(signedProof);
        return base64.encode(signedProof.extract());
    }
}

const OP_RETURN_EMPTY_PKSCRIPT = new Uint8Array([OP.RETURN]);
const ZERO_32 = new Uint8Array(32).fill(0);
const MAX_INDEX = 0xffffffff;
const TAG_BIP322 = "BIP0322-signed-message";

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
    if (input.index === undefined) throw ErrMissingData;
    if (input.txid === undefined) throw ErrMissingData;
    if (input.witnessUtxo === undefined) throw ErrMissingWitnessUtxo;
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
    if (output.amount === undefined) throw ErrMissingData;
    if (output.script === undefined) throw ErrMissingData;
    return true;
}

function validateOutputs(
    outputs: TransactionOutput[]
): outputs is ValidatedTxOutput[] {
    outputs.forEach(validateOutput);
    return true;
}

// craftToSpendTx creates the initial transaction that will be spent in the proof
export function craftToSpendTx(
    message: string,
    pkScript: Uint8Array
): Transaction {
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
    for (const input of inputs) {
        tx.addInput({
            ...input,
            sighashType: SigHash.ALL,
        });
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
        TAG_BIP322,
        new TextEncoder().encode(message)
    );
}
