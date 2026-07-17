import { schnorr } from "@noble/curves/secp256k1.js";
import { base64, hex } from "@scure/base";
import { DEFAULT_SEQUENCE, Script, SigHash } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { TransactionOutput } from "@scure/btc-signer/psbt.js";
import { ExtendedCoin, VirtualCoin } from "../wallet";
import { CLTVMultisigTapscript, decodeTapscript, RelativeTimelock } from "../script/tapscript";
import {
    EncodedVtxoScript,
    scriptFromTapLeafScript,
    TapLeafScript,
    VtxoScript,
} from "../script/base";
import { P2A } from "./anchor";
import { CSVMultisigTapscript } from "../script/tapscript";
import { setArkPsbtField, VtxoTaprootTree } from "./unknownFields";
import { Transaction } from "./transaction";
import { ArkAddress } from "../script/address";
import { Extension } from "../extension";

export type ArkTxInput = {
    // the script used to spend the virtual output
    tapLeafScript: TapLeafScript;
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
 * core function for creating Arkade transactions.
 *
 * @param inputs - Array of virtual transaction inputs
 * @param outputs - Array of transaction outputs
 * @param serverUnrollScript - Server unroll script for checkpoint transactions
 * @returns Object containing the virtual transaction and checkpoint transactions
 */
export function buildOffchainTx(
    inputs: ArkTxInput[],
    outputs: TransactionOutput[],
    serverUnrollScript: CSVMultisigTapscript.Type,
): OffchainTx {
    // TODO: use arkd /info
    const MAX_OP_RETURN = 2;

    let countOpReturn = 0;
    let hasExtensionOutput = false;
    for (const [index, output] of outputs.entries()) {
        if (!output.script) throw new Error(`missing output script ${index}`);
        const isExtension = Extension.isExtension(output.script);
        const isOpReturn = isExtension || Script.decode(output.script)[0] === "RETURN";
        if (isOpReturn) {
            countOpReturn++;
        }
        if (!isExtension) continue;
        if (hasExtensionOutput) throw new Error("multiple extension outputs");
        hasExtensionOutput = true;
    }

    if (countOpReturn > MAX_OP_RETURN) {
        throw new Error(`too many OP_RETURN outputs: ${countOpReturn} > ${MAX_OP_RETURN}`);
    }

    const checkpoints = inputs.map((input) => buildCheckpointTx(input, serverUnrollScript));

    const arkTx = buildVirtualTx(
        checkpoints.map((c) => c.input),
        outputs,
    );

    return {
        arkTx,
        checkpoints: checkpoints.map((c) => c.tx),
    };
}

function buildVirtualTx(inputs: ArkTxInput[], outputs: TransactionOutput[]) {
    let lockTime = 0n;
    for (const input of inputs) {
        const tapscript = decodeTapscript(scriptFromTapLeafScript(input.tapLeafScript));
        if (CLTVMultisigTapscript.is(tapscript)) {
            if (lockTime !== 0n) {
                // if a locktime is already set, check if the new locktime is in the same unit
                if (isSeconds(lockTime) !== isSeconds(tapscript.params.absoluteTimelock)) {
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
    serverUnrollScript: CSVMultisigTapscript.Type,
): { tx: Transaction; input: ArkTxInput } {
    // create the checkpoint virtual output script from collaborative closure
    const collaborativeClosure = decodeTapscript(scriptFromTapLeafScript(vtxo.tapLeafScript));

    // create the checkpoint virtual output script combining collaborative closure and server unroll script
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
        ],
    );

    // get the collaborative leaf proof
    const collaborativeLeafProof = checkpointVtxoScript.findLeaf(
        hex.encode(collaborativeClosure.script),
    );

    // create the checkpoint input that will be used as input of the virtual tx
    const checkpointInput = {
        txid: checkpointTx.id,
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
    boardingTimelock: RelativeTimelock,
    chainTipHeight?: number,
) {
    if (!coin.status.block_time) return false;
    if (boardingTimelock.value === 0n) return true;

    if (boardingTimelock.type === "blocks") {
        if (chainTipHeight === undefined || !coin.status.block_height) return false;
        return BigInt(chainTipHeight - coin.status.block_height) >= boardingTimelock.value;
    }

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
    allowedSighashTypes: number[] = [SigHash.DEFAULT],
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
        const sighashType = signature.length === 65 ? signature[64] : SigHash.DEFAULT;
        const sig = signature.subarray(0, 64);

        // Verify sighash type is allowed
        if (!allowedSighashTypes.includes(sighashType)) {
            const sighashName = formatSighash(sighashType);
            throw new Error(
                `Unallowed sighash type ${sighashName} for input ${inputIndex}, pubkey ${pubKeyHex}.`,
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
                `Input ${inputIndex}: No tapLeafScript found matching leafHash ${hex.encode(leafHash)}`,
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
            matchingVersion,
        );

        // Verify the schnorr signature
        const isValid = schnorr.verify(sig, message, pubKey);

        if (!isValid) {
            throw new Error(`Invalid signature for input ${inputIndex}, pubkey ${pubKeyHex}`);
        }
    }

    // Verify we have signatures from all required signers (excluding those we're skipping)
    const signedPubkeys = input.tapScriptSig.map(([data]) => hex.encode(data.pubKey));
    const requiredNotExcluded = requiredSigners.filter((pk) => !excludePubkeys.includes(pk));
    const missingSigners = requiredNotExcluded.filter((pk) => !signedPubkeys.includes(pk));

    if (missingSigners.length > 0) {
        throw new Error(
            `Missing signatures from: ${missingSigners.map((pk) => pk.slice(0, 16)).join(", ")}...`,
        );
    }
}

/**
 * Merges the tapscript signatures of `signedTx` onto `originalTx`, in place.
 *
 * Invariant: both transactions must have the same number of inputs and BOTH
 * must carry a `tapScriptSig` on every input — the result is the per-input
 * concatenation `originalTx.tapScriptSig ++ signedTx.tapScriptSig`. A missing
 * signature on either side is rejected with an input-indexed error rather than
 * silently corrupting the witness (the previous code appended `undefined` when
 * `signedTx` was unsigned). Callers that partially sign must merge only fully
 * co-signed inputs.
 *
 * @param signedTx signed transaction
 * @param originalTx original transaction (mutated and returned)
 */
export function combineTapscriptSigs(signedTx: Transaction, originalTx: Transaction) {
    if (signedTx.inputsLength !== originalTx.inputsLength) {
        throw new Error(
            `combineTapscriptSigs: input count mismatch (signedTx ${signedTx.inputsLength}, originalTx ${originalTx.inputsLength})`,
        );
    }
    for (let i = 0; i < signedTx.inputsLength; i++) {
        const input = originalTx.getInput(i);
        const signedInput = signedTx.getInput(i);
        if (!input.tapScriptSig) {
            throw new Error(`combineTapscriptSigs: originalTx input ${i} has no tapScriptSig`);
        }
        if (!signedInput.tapScriptSig) {
            throw new Error(`combineTapscriptSigs: signedTx input ${i} has no tapScriptSig`);
        }
        originalTx.updateInput(i, {
            tapScriptSig: input.tapScriptSig.concat(signedInput.tapScriptSig),
        });
    }
    return originalTx;
}

/**
 * Validates if a given string is a valid Arkade address by attempting to decode it.
 * @param address The Arkade address to validate.
 * @returns True if the address is valid, false otherwise.
 */
export function isValidArkAddress(address: string): boolean {
    try {
        ArkAddress.decode(address);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Minimal Ark provider surface required to submit and finalize an offchain
 * transaction. Both {@link ArkProvider} implementations satisfy it
 * structurally, so declaring it here keeps this module free of a provider
 * import (and of the dependency cycle that would create).
 */
export interface OffchainTxSubmitProvider {
    submitTx(
        signedArkTx: string,
        checkpointTxs: string[],
    ): Promise<{ arkTxid: string; signedCheckpointTxs: string[] }>;
    finalizeTx(arkTxid: string, finalCheckpointTxs: string[]): Promise<void>;
}

/**
 * Signing strategy for an offchain transaction, abstracting the two ways the
 * owner's signatures are produced:
 *
 * - The wallet path routes each input to its owning contract's key
 *   (`InputSignerRouter`) and, when every input resolves to the baseline key,
 *   batch-signs the arkTx and all checkpoints in one popup — returning the
 *   user-signed checkpoints from {@link signArkTx} so they are merged onto the
 *   server's signatures.
 * - A single-key spend (e.g. an ArkCash sweep) signs every input with one
 *   identity and lets each server-returned checkpoint be signed afterwards via
 *   {@link signCheckpoint}.
 */
export interface OffchainTxSigner {
    /**
     * Sign the ark (virtual) transaction. May optionally also return
     * user-signed checkpoint transactions (batch path); when present, they are
     * merged onto the server-signed checkpoints instead of calling
     * {@link signCheckpoint}.
     */
    signArkTx(
        arkTx: Transaction,
        checkpoints: Transaction[],
    ): Promise<{ arkTx: Transaction; userSignedCheckpoints?: Transaction[] }>;
    /**
     * Add the owner's signature to a single server-returned checkpoint
     * transaction. Only invoked when {@link signArkTx} returned no
     * `userSignedCheckpoints` (the non-batch path).
     */
    signCheckpoint(checkpoint: Transaction): Promise<Transaction>;
}

/**
 * Submit a pre-built offchain transaction to the Ark server and finalize it.
 *
 * Owns the submit → checkpoint-sign → finalize sequence shared by every Ark
 * spend path (the wallet send/migration path and the single-key ArkCash
 * sweep). The signing strategy is injected via {@link OffchainTxSigner} so a
 * caller holding a single key does not pull in the wallet's router/batch
 * machinery. Optional {@link hooks} let the wallet mark/clear its pending-tx
 * recovery flag around the network round-trip; a stateless caller omits them.
 *
 * @returns The Ark transaction id and the server-signed checkpoint PSBTs
 * (the raw server response, for the wallet's bookkeeping).
 */
export async function submitOffchainTx(
    provider: OffchainTxSubmitProvider,
    offchainTx: OffchainTx,
    signer: OffchainTxSigner,
    hooks?: { beforeSubmit?: () => Promise<void>; afterFinalize?: () => Promise<void> },
): Promise<{ arkTxid: string; signedCheckpointTxs: string[] }> {
    const { arkTx: signedArkTx, userSignedCheckpoints } = await signer.signArkTx(
        offchainTx.arkTx,
        offchainTx.checkpoints,
    );

    // The checkpoint set built here is the source of truth: every one of them
    // must reach finalizeTx signed. Both the signer's array and the server's are
    // therefore checked against it rather than against each other — two equally
    // truncated arrays agree with each other while still dropping a checkpoint.
    // A miscounting signer is caught before submitTx, so it fails outright
    // instead of stranding a registered-but-unfinalizable tx on the server.
    if (userSignedCheckpoints && userSignedCheckpoints.length !== offchainTx.checkpoints.length) {
        throw new Error(
            `signer returned ${userSignedCheckpoints.length} signed checkpoints, expected ${offchainTx.checkpoints.length}`,
        );
    }

    // Mark pending before submitting — if the caller crashes between submit and
    // finalize, its recovery hook can retry from persisted state.
    await hooks?.beforeSubmit?.();

    const { arkTxid, signedCheckpointTxs } = await provider.submitTx(
        base64.encode(signedArkTx.toPSBT()),
        offchainTx.checkpoints.map((c) => base64.encode(c.toPSBT())),
    );

    // The server returns one signed checkpoint per submitted checkpoint; both
    // branches below pair them positionally. A short response would silently
    // drop the tail (→ incomplete finalizeTx), a long one would carry
    // checkpoints that were never built.
    if (signedCheckpointTxs.length !== offchainTx.checkpoints.length) {
        throw new Error(
            `submitTx returned ${signedCheckpointTxs.length} checkpoints, expected ${offchainTx.checkpoints.length}`,
        );
    }

    let finalCheckpoints: string[];
    if (userSignedCheckpoints) {
        finalCheckpoints = signedCheckpointTxs.map((c, i) => {
            const serverSigned = Transaction.fromPSBT(base64.decode(c));
            combineTapscriptSigs(userSignedCheckpoints[i], serverSigned);
            return base64.encode(serverSigned.toPSBT());
        });
    } else {
        finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (c) => {
                const tx = Transaction.fromPSBT(base64.decode(c));
                const signed = await signer.signCheckpoint(tx);
                return base64.encode(signed.toPSBT());
            }),
        );
    }

    await provider.finalizeTx(arkTxid, finalCheckpoints);
    await hooks?.afterFinalize?.();

    return { arkTxid, signedCheckpointTxs };
}

/**
 * Build, sign, submit, and finalize an offchain transaction whose every input
 * is controlled by a single key — the "thin signer" path.
 *
 * Needs no wallet, repository, or contract state: just an identity that can
 * sign, an Ark provider, the inputs (already carrying their spend leaf and tap
 * tree), the outputs, and the server unroll script. Used by the ArkCash sweep
 * to move bearer coins to the receiver's address without spinning up a full
 * background-managed wallet on shared repositories.
 *
 * @returns The Ark transaction id.
 */
export async function signAndSubmitOffchainTx(params: {
    identity: { sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> };
    provider: OffchainTxSubmitProvider;
    inputs: ArkTxInput[];
    outputs: TransactionOutput[];
    serverUnrollScript: CSVMultisigTapscript.Type;
}): Promise<string> {
    const offchainTx = buildOffchainTx(params.inputs, params.outputs, params.serverUnrollScript);
    // Single key: every input is signed by the same identity (all indexes), and
    // each server-returned checkpoint is signed the same way. No router, no
    // batch popup — signing is in-process and free.
    const signer: OffchainTxSigner = {
        signArkTx: async (arkTx) => ({ arkTx: await params.identity.sign(arkTx) }),
        signCheckpoint: (checkpoint) => params.identity.sign(checkpoint),
    };
    const { arkTxid } = await submitOffchainTx(params.provider, offchainTx, signer);
    return arkTxid;
}
