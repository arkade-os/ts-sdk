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
import { ConditionWitness, setArkPsbtField, VtxoTaprootTree } from "./unknownFields";
import { Transaction } from "./transaction";
import { ArkAddress } from "../script/address";
import { Extension } from "../extension";
import { ServerResponseMismatchError } from "../providers/errors";

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

/**
 * Build the checkpoint transaction spending `vtxo`, plus the input that spends
 * it (the ark tx's actual input).
 *
 * A pure function of `(vtxo, serverUnrollScript)` — nothing here is
 * server-supplied — so finalization paths can rebuild the checkpoint they
 * expect from their own VTXO data and reject any other one.
 */
export function buildCheckpointTx(
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
 * @param expectedLeafHash Tapscript leaf hash the signatures must commit to. When omitted, a
 * signature over any leaf carried by the input is accepted.
 * @throws Error if verification fails
 */
export function verifyTapscriptSignatures(
    tx: Transaction,
    inputIndex: number,
    requiredSigners: string[],
    excludePubkeys: string[] = [],
    allowedSighashTypes: number[] = [SigHash.DEFAULT],
    expectedLeafHash?: Uint8Array,
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

    const expectedLeafHashHex = expectedLeafHash ? hex.encode(expectedLeafHash) : undefined;

    // Verify each signature in tapScriptSig
    for (const [tapScriptSigData, signature] of input.tapScriptSig) {
        const pubKey = tapScriptSigData.pubKey;
        const pubKeyHex = hex.encode(pubKey);

        // Skip verification for excluded pubkeys
        if (excludePubkeys.includes(pubKeyHex)) {
            continue;
        }

        if (expectedLeafHashHex !== undefined) {
            const signedLeafHex = hex.encode(tapScriptSigData.leafHash);
            if (signedLeafHex !== expectedLeafHashHex) {
                throw new Error(
                    `Input ${inputIndex}: signature from ${pubKeyHex} commits to leaf ${signedLeafHex}, expected ${expectedLeafHashHex}`,
                );
            }
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
    ): Promise<{ arkTxid: string; finalArkTx?: string; signedCheckpointTxs: string[] }>;
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
 * - A single-key spend (e.g. an ArkadeCash sweep) signs every input with one
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
 * Pair each server-returned checkpoint PSBT with the locally built checkpoint
 * of the same txid, rejecting anything else.
 *
 * The ark tx signed just above spends each checkpoint at `checkpointTxid:0`, so
 * the response is only usable if it carries the same txids: a checkpoint with
 * any other txid leaves that ark tx unspendable. The two sets are therefore
 * equal by construction, and this pairing is what the signing step below
 * consumes.
 *
 * Matching is by txid rather than by position — nothing in the wire contract
 * promises arkd echoes checkpoints in submission order — while the result keeps
 * the server's order, so nothing downstream is reordered.
 *
 * Comparing txids is sound while checkpoint inputs are taproot-only: witness
 * data does not affect the txid, so the server's signature cannot change it. A
 * future P2SH-wrapped/scriptSig input could acquire a `finalScriptSig`
 * server-side and legitimately change txid; that protocol shape would need a
 * different comparison target.
 */
export function matchServerCheckpoints(
    serverCheckpointTxs: string[],
    expectedCheckpoints: Transaction[],
    context: string,
): { server: Transaction; local: Transaction }[] {
    if (serverCheckpointTxs.length !== expectedCheckpoints.length) {
        throw new ServerResponseMismatchError(
            `${context} returned ${serverCheckpointTxs.length} checkpoints, expected ${expectedCheckpoints.length}`,
        );
    }

    // Checkpoints spend distinct VTXOs, so their txids are distinct and the map
    // cannot collapse two entries. Deleting on match keeps a duplicated server
    // txid from satisfying two slots; with equal counts that gives a bijection.
    const byTxid = new Map(expectedCheckpoints.map((c) => [c.id, c]));

    return serverCheckpointTxs.map((encoded, index) => {
        const server = Transaction.fromPSBT(base64.decode(encoded));
        const local = byTxid.get(server.id);
        if (!local) {
            throw new ServerResponseMismatchError(
                `${context} checkpoint ${index} txid ${server.id} does not match any submitted checkpoint`,
            );
        }
        byTxid.delete(server.id);
        return { server, local };
    });
}

/**
 * Assert a `submitTx` response refers to the ark transaction just submitted.
 *
 * The returned `arkTxid` is what gets passed to `finalizeTx` and persisted by
 * callers, so a stale or misrouted response must be rejected before either
 * happens: it must equal the locally signed transaction's txid, and when the
 * response carries the counter-signed `finalArkTx`, that transaction's txid
 * must match too. Server signatures live in the witness and cannot
 * legitimately change either — with the same taproot-only caveat as
 * {@link matchServerCheckpoints}.
 */
export function assertSubmittedArkTxid(
    response: { arkTxid: string; finalArkTx?: string },
    signedArkTx: Transaction,
    context: string,
): void {
    if (response.arkTxid !== signedArkTx.id) {
        throw new ServerResponseMismatchError(
            `${context} returned ark txid ${response.arkTxid}, expected ${signedArkTx.id}`,
        );
    }
    if (response.finalArkTx === undefined) return;
    const finalTxid = Transaction.fromPSBT(base64.decode(response.finalArkTx)).id;
    if (finalTxid !== signedArkTx.id) {
        throw new ServerResponseMismatchError(
            `${context} returned final ark tx ${finalTxid}, expected ${signedArkTx.id}`,
        );
    }
}

/**
 * Opt-in proof that the server co-signed what it handed back.
 *
 * Be precise about what this buys, because it is less than it sounds like. It
 * does NOT protect a preimage or any other condition value: those reach the
 * server at `submitTx`, before any of this runs. What it buys is a loud,
 * immediate failure instead of a caller reporting success, watching nothing
 * confirm, and learning the truth when the counterparty's refund lands.
 */
export interface VerifyServerSignatures {
    /** The Ark server's key; x-only or compressed, both accepted. */
    serverPubkey: Uint8Array;
}

/**
 * Verify the server's signature on one input of `serverTx` against the leaf
 * the LOCAL transaction spends at that index.
 *
 * Two things this ordering buys. The expected leaf is read from `localTx`, so a
 * response carrying some other leaf is a mismatch rather than a self-consistent
 * pass — taking the leaf from the server's own copy would ask the counterparty
 * what it should have signed. And it is per-input, so a transaction mixing
 * leaves, or spending several contracts at once, is checked honestly instead of
 * against one assumed-shared leaf.
 */
function assertServerSignedLeaf(
    serverTx: Transaction,
    localTx: Transaction,
    inputIndex: number,
    serverPubkeyHex: string,
    context: string,
): void {
    const leaf = localTx.getInput(inputIndex).tapLeafScript?.[0];
    if (!leaf) {
        throw new Error(
            `${context}: input ${inputIndex} carries no spend leaf to verify the server signature against`,
        );
    }
    try {
        verifyTapscriptSignatures(
            serverTx,
            inputIndex,
            [serverPubkeyHex],
            undefined,
            undefined,
            tapLeafHash(scriptFromTapLeafScript(leaf)),
        );
    } catch (error) {
        throw new ServerResponseMismatchError(
            `${context}: input ${inputIndex} is not signed by the server on the leaf being spent ` +
                `(${error instanceof Error ? error.message : String(error)})`,
        );
    }
}

/**
 * Assert every checkpoint in `checkpoints` is the one this wallet would build
 * for one of `inputs`, by rebuilding it from local VTXO data.
 *
 * Used by the finalization paths, which resume a transaction submitted in an
 * earlier process and so have no locally built set to compare against. The
 * expected checkpoint is a pure function of `(VTXO, server unroll script)`, so
 * it can simply be derived again.
 *
 * `unrollCandidates` accepts more than one script because the checkpoint output
 * commits to the server key that was current when it was built — a tx submitted
 * before a signer rotation and finalized after it must still match.
 */
export function assertCheckpointsMatchInputs(
    checkpoints: Transaction[],
    inputs: ArkTxInput[],
    unrollCandidates: CSVMultisigTapscript.Type[],
    context: string,
): void {
    const byOutpoint = new Map(inputs.map((input) => [`${input.txid}:${input.vout}`, input]));

    for (const [index, checkpoint] of checkpoints.entries()) {
        if (checkpoint.inputsLength !== 1) {
            throw new ServerResponseMismatchError(
                `${context}: checkpoint ${index} spends ${checkpoint.inputsLength} inputs, expected 1`,
            );
        }

        const spent = checkpoint.getInput(0);
        if (!spent.txid || spent.index === undefined) {
            throw new ServerResponseMismatchError(
                `${context}: checkpoint ${index} has no input outpoint`,
            );
        }

        const outpoint = `${hex.encode(spent.txid)}:${spent.index}`;
        const input = byOutpoint.get(outpoint);
        if (!input) {
            throw new ServerResponseMismatchError(
                `${context}: checkpoint ${index} spends ${outpoint}, which is not one of the requested virtual outputs`,
            );
        }

        const rebuilt = unrollCandidates.some(
            (unroll) => buildCheckpointTx(input, unroll).tx.id === checkpoint.id,
        );
        if (!rebuilt) {
            throw new ServerResponseMismatchError(
                `${context}: checkpoint ${index} txid ${checkpoint.id} differs from the checkpoint built locally for ${outpoint}`,
            );
        }
    }
}

/**
 * Submit a pre-built offchain transaction to the Ark server and finalize it.
 *
 * Owns the submit → checkpoint-sign → finalize sequence shared by every Ark
 * spend path (the wallet send/migration path and the single-key ArkadeCash
 * sweep). The signing strategy is injected via {@link OffchainTxSigner} so a
 * caller holding a single key does not pull in the wallet's router/batch
 * machinery. Optional {@link hooks} let the wallet mark/clear its pending-tx
 * recovery flag around the network round-trip; a stateless caller omits them.
 *
 * `options.verifyServerSignatures` is off by default, so every existing caller
 * is unchanged; see {@link VerifyServerSignatures} for what it does and does
 * not prove.
 *
 * @returns The Ark transaction id and the server-signed checkpoint PSBTs
 * (the raw server response, for the wallet's bookkeeping).
 */
export async function submitOffchainTx(
    provider: OffchainTxSubmitProvider,
    offchainTx: OffchainTx,
    signer: OffchainTxSigner,
    hooks?: { beforeSubmit?: () => Promise<void>; afterFinalize?: () => Promise<void> },
    options?: { verifyServerSignatures?: VerifyServerSignatures },
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

    const response = await provider.submitTx(
        base64.encode(signedArkTx.toPSBT()),
        offchainTx.checkpoints.map((c) => base64.encode(c.toPSBT())),
    );
    assertSubmittedArkTxid(response, signedArkTx, "submitTx");
    const { arkTxid, signedCheckpointTxs } = response;

    // The server returns one signed checkpoint per submitted checkpoint, and
    // each must be one we built: nothing below signs a checkpoint that has not
    // been matched to a local one.
    const matched = matchServerCheckpoints(signedCheckpointTxs, offchainTx.checkpoints, "submitTx");

    const verify = options?.verifyServerSignatures;
    if (verify) {
        // Fail closed: `finalArkTx` is optional in the wire type and
        // `assertSubmittedArkTxid` skips it when absent, but a check that was
        // asked for and cannot be run is a failed check, not a passed one.
        if (response.finalArkTx === undefined) {
            throw new ServerResponseMismatchError(
                "submitTx: server returned no final ark tx to verify its signatures against",
            );
        }
        const finalArkTx = Transaction.fromPSBT(base64.decode(response.finalArkTx));
        const serverPubkeyHex = hex.encode(
            verify.serverPubkey.length === 33
                ? verify.serverPubkey.subarray(1)
                : verify.serverPubkey,
        );
        for (let i = 0; i < offchainTx.arkTx.inputsLength; i++) {
            assertServerSignedLeaf(
                finalArkTx,
                offchainTx.arkTx,
                i,
                serverPubkeyHex,
                "submitTx ark tx",
            );
        }
        // Each checkpoint carries exactly one input, the VTXO being spent.
        matched.forEach(({ server, local }, index) =>
            assertServerSignedLeaf(
                server,
                local,
                0,
                serverPubkeyHex,
                `submitTx checkpoint ${index}`,
            ),
        );
    }

    let finalCheckpoints: string[];
    if (userSignedCheckpoints) {
        // The signer's array is positional against `offchainTx.checkpoints`, so
        // it is indexed by txid too rather than paired with the server's order.
        const userByTxid = new Map(
            userSignedCheckpoints.map((c, i) => [offchainTx.checkpoints[i].id, c] as const),
        );
        finalCheckpoints = matched.map(({ server, local }) => {
            combineTapscriptSigs(userByTxid.get(local.id)!, server);
            return base64.encode(server.toPSBT());
        });
    } else {
        finalCheckpoints = await Promise.all(
            matched.map(async ({ server }) => {
                const signed = await signer.signCheckpoint(server);
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
 * tree), the outputs, and the server unroll script. Used by the ArkadeCash sweep
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
    /** Forwarded to {@link submitOffchainTx}; omitted, nothing is checked. */
    verifyServerSignatures?: VerifyServerSignatures;
}): Promise<string> {
    const offchainTx = buildOffchainTx(params.inputs, params.outputs, params.serverUnrollScript);
    // Single key: every input is signed by the same identity (all indexes), and
    // each server-returned checkpoint is signed the same way. No router, no
    // batch popup — signing is in-process and free.
    const signer: OffchainTxSigner = {
        signArkTx: async (arkTx) => ({ arkTx: await params.identity.sign(arkTx) }),
        signCheckpoint: (checkpoint) => params.identity.sign(checkpoint),
    };
    const { arkTxid } = await submitOffchainTx(params.provider, offchainTx, signer, undefined, {
        verifyServerSignatures: params.verifyServerSignatures,
    });
    return arkTxid;
}

/**
 * Decorate a signer so it reveals `preimage` on every input it signs.
 *
 * The ordering encoded here is the whole point: the condition witness is NOT
 * part of what is signed, so attaching it before signing leaves a signature
 * over a PSBT that no longer matches once the field is present — which the
 * server rejects as `INVALID_SIGNATURE`. Decorate per spend, never wallet-wide.
 *
 * For any condition-leaf spend (VHTLC claims on both swap directions); the
 * generic signature keeps the decorated identity's own type, so the result is
 * still whatever was passed in.
 */
export function claimWithPreimageIdentity<
    T extends { sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> },
>(identity: T, preimage: Uint8Array): T {
    return {
        ...identity,
        sign: async (tx: Transaction, inputIndexes?: number[]): Promise<Transaction> => {
            // Clone-and-round-trip so the caller's transaction is never mutated
            // and the signed result is a fresh object we can add a field to.
            const signed = Transaction.fromPSBT(
                (await identity.sign(tx.clone(), inputIndexes)).toPSBT(),
            );
            const indexes =
                inputIndexes ?? Array.from({ length: signed.inputsLength }, (_, i) => i);
            for (const index of indexes) {
                setArkPsbtField(signed, index, ConditionWitness, [preimage]);
            }
            return signed;
        },
    };
}
