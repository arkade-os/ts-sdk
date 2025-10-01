import {
    DEFAULT_SEQUENCE,
    Transaction,
    SigHash,
} from "@scure/btc-signer/transaction.js";
import { ExtendedCoin, VirtualCoin } from "../wallet";
import {
    CLTVMultisigTapscript,
    decodeTapscript,
    RelativeTimelock,
} from "../script/tapscript";
import {
    EncodedVtxoScript,
    scriptFromTapLeafScript,
    TapLeafScript,
    VtxoScript,
} from "../script/base";
import { P2A } from "./anchor";
import { CSVMultisigTapscript } from "../script/tapscript";
import { hex } from "@scure/base";
import { TransactionOutput } from "@scure/btc-signer/psbt.js";
import { Bytes, sha256x2 } from "@scure/btc-signer/utils.js";
import { setArkPsbtField, VtxoTaprootTree } from "./unknownFields";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { schnorr } from "@noble/curves/secp256k1";

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

export function hasBoardingTxExpired(
    coin: ExtendedCoin,
    boardingTimelock: RelativeTimelock
) {
    if (!coin.status.block_time) return false;
    if (boardingTimelock.value === 0n) return true;
    if (boardingTimelock.type !== "blocks") return false; // TODO: handle get chain tip

    // validate expiry in terms of seconds
    const now = BigInt(Math.floor(Date.now() / 1000));
    const blockTime = BigInt(Math.floor(coin.status.block_time));
    return blockTime + boardingTimelock.value <= now;
}

/**
 * Formats a sighash type as a hex string (e.g., 0x01)
 */
function formatSighash(type: number): string {
    return `0x${type.toString(16).padStart(2, "0")}`;
}

/**
 * Verify tapscript signatures on a transaction input
 * @param tx Transaction to verify
 * @param inputIndex Index of the input to verify
 * @param requiredSigners List of required signer pubkeys (hex encoded)
 * @param excludePubkeys List of pubkeys to exclude from verification (hex encoded, e.g., server key not yet signed)
 * @param allowedSighashTypes List of allowed sighash types (defaults to [SigHash.DEFAULT])
 * @throws Error if verification fails
 */
export function verifyTapscriptSignatures(
    tx: Transaction,
    inputIndex: number,
    requiredSigners: string[],
    excludePubkeys: string[] = [],
    allowedSighashTypes: number[] = [SigHash.DEFAULT]
): void {
    const input = tx.getInput(inputIndex);

    // Collect prevout scripts and amounts for ALL inputs (required for preimageWitnessV1)
    const prevoutScripts: Uint8Array[] = [];
    const prevoutAmounts: bigint[] = [];

    for (let i = 0; i < tx.inputsLength; i++) {
        const inp = tx.getInput(i);
        if (!inp.witnessUtxo) {
            throw new Error(`Input ${i} is missing witnessUtxo`);
        }
        prevoutScripts.push(inp.witnessUtxo.script);
        prevoutAmounts.push(inp.witnessUtxo.amount);
    }

    // Verify tapScriptSig signatures
    if (!input.tapScriptSig || input.tapScriptSig.length === 0) {
        throw new Error(`Input ${inputIndex} is missing tapScriptSig`);
    }

    // Verify each signature in tapScriptSig
    for (const [tapScriptSigData, signature] of input.tapScriptSig) {
        const pubKey = tapScriptSigData.pubKey;
        const pubKeyHex = hex.encode(pubKey);

        // Skip verification for excluded pubkeys
        if (excludePubkeys.includes(pubKeyHex)) {
            continue;
        }

        // Extract sighash type from signature
        // Schnorr signatures are 64 bytes, with optional 1-byte sighash appended
        const sighashType =
            signature.length === 65 ? signature[64] : SigHash.DEFAULT;
        const sig = signature.subarray(0, 64);

        // Verify sighash type is allowed
        if (!allowedSighashTypes.includes(sighashType)) {
            const sighashName = formatSighash(sighashType);
            throw new Error(
                `Unallowed sighash type ${sighashName} for input ${inputIndex}, pubkey ${pubKeyHex}.`
            );
        }

        // Find the tapLeafScript that matches this signature's leafHash
        if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
            throw new Error();
        }

        // Search for the leaf that matches the leafHash in tapScriptSigData
        const leafHash = tapScriptSigData.leafHash;
        const leafHashHex = hex.encode(leafHash);
        let matchingScript: Uint8Array | undefined;
        let matchingVersion: number | undefined;

        for (const [_, scriptWithVersion] of input.tapLeafScript) {
            const script = scriptWithVersion.subarray(0, -1);
            const version = scriptWithVersion[scriptWithVersion.length - 1];

            // Compute the leaf hash for this script and compare as hex strings
            const computedLeafHash = tapLeafHash(script, version);
            const computedHex = hex.encode(computedLeafHash);

            if (computedHex === leafHashHex) {
                matchingScript = script;
                matchingVersion = version;
                break;
            }
        }

        if (!matchingScript || matchingVersion === undefined) {
            throw new Error(
                `Input ${inputIndex}: No tapLeafScript found matching leafHash ${hex.encode(leafHash)}`
            );
        }

        // Reconstruct the message that was signed
        // Note: preimageWitnessV1 requires ALL input prevout scripts and amounts
        const message = tx.preimageWitnessV1(
            inputIndex,
            prevoutScripts,
            sighashType,
            prevoutAmounts,
            undefined,
            matchingScript,
            matchingVersion
        );

        // Verify the schnorr signature
        const isValid = schnorr.verify(sig, message, pubKey);

        if (!isValid) {
            throw new Error(
                `Invalid signature for input ${inputIndex}, pubkey ${pubKeyHex}`
            );
        }
    }

    // Verify we have signatures from all required signers (excluding those we're skipping)
    const signedPubkeys = input.tapScriptSig.map(([data]) =>
        hex.encode(data.pubKey)
    );
    const requiredNotExcluded = requiredSigners.filter(
        (pk) => !excludePubkeys.includes(pk)
    );
    const missingSigners = requiredNotExcluded.filter(
        (pk) => !signedPubkeys.includes(pk)
    );

    if (missingSigners.length > 0) {
        throw new Error(
            `Missing signatures from: ${missingSigners.map((pk) => pk.slice(0, 16)).join(", ")}...`
        );
    }
}
