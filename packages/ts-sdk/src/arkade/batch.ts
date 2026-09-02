/**
 * Arkade Batch Handler
 *
 * Factory function that creates a `Batch.Handler` for arkade-script
 * transactions with emulator co-signing. Handles both on-chain
 * boarding inputs and off-chain virtual VTXO settlement in a single batch.
 *
 * @module arkade/batch
 */

import { base64, hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";
import { SigHash, OutScript, Address } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";

import type { Identity } from "../identity";
import type { ArkProvider } from "../providers/ark";
import type { EmulatorProvider, ConnectorTreeNode } from "../providers/emulator";
import type { Network } from "../networks";
import type { ExtendedCoin, Recipient } from "../wallet";
import type { SignerSession } from "../tree/signingSession";
import type {
    BatchStartedEvent,
    TreeSigningStartedEvent,
    TreeNoncesEvent,
    BatchFinalizationEvent,
} from "../providers/ark";

import { VtxoScript } from "../script/base";
import { CSVMultisigTapscript } from "../script/tapscript";
import { assertValidBatchExpiry, resolveBatchExpiryPolicy } from "../wallet/batchExpiry";
import type { BatchExpiryPolicy } from "../wallet/batchExpiry";
import { Transaction } from "../utils/transaction";
import { validateConnectorsTxGraph, validateVtxoTxGraph } from "../tree/validation";
import {
    assertFinalCommitmentMatchesValidated,
    validateBatchRecipients,
    validateBatchRecipientsWithoutTree,
} from "../wallet/validation";
import { buildForfeitTx } from "../forfeit";
import { Batch } from "../wallet/batch";
import { Intent } from "../intent";
import { canRecoverOnchain, isSubdust, isVirtualCoin } from "../wallet";
import { toXOnly } from "../utils/keys";
import type { ExtendedVirtualCoin } from "../wallet";
import type { TxTree } from "../tree/txTree";

/** An onchain boarding input to an arkade batch. */
export type ArkadeExtendedCoin = ExtendedCoin & {
    arkadeScriptBytes: Uint8Array;
};

/** A virtual output input to an arkade batch. */
export type ArkadeExtendedVirtualCoin = ExtendedVirtualCoin & {
    arkadeScriptBytes: Uint8Array;
};

/**
 * An input to {@link createArkadeBatchHandler}, boarding or virtual.
 *
 * @remarks
 * Spelled as a union so the discriminant {@link isVtxoCoin} reads — `script`, required on
 * `VirtualCoin` and absent from `ExtendedCoin` — is visible in the type. `ArkadeExtendedCoin[]`
 * alone would let a caller hand over a virtual output with no `script`, which the handler would
 * silently treat as boarding and settle without a forfeit.
 */
export type ArkadeBatchInput = ArkadeExtendedCoin | ArkadeExtendedVirtualCoin;

const isVtxoCoin = (input: ArkadeBatchInput): input is ArkadeExtendedVirtualCoin =>
    isVirtualCoin(input);

export function createArkadeBatchHandler(
    intentId: string,
    inputs: ArkadeBatchInput[],
    signer: Identity,
    signedProof: string,
    message: Intent.RegisterMessage,
    session: SignerSession,
    arkProvider: ArkProvider,
    emulator: EmulatorProvider,
    network: Network,
    /**
     * Expected recipients of the settlement, validated against the virtual
     * output tree before co-signing it, and — when tree signing did not run —
     * against the commitment tx before signing anything at finalization
     * (mirrors `Wallet.createBatchHandler`). Without this the handler signs
     * whatever the server proposes, on both paths.
     */
    recipients?: Recipient[],
    /** Overrides for the `batchExpiry` bounds; defaults derive from `network`. */
    batchExpiryPolicy?: Partial<BatchExpiryPolicy>,
): Batch.Handler {
    let batchId: string;
    let sweepTapTreeRoot: Uint8Array;
    // Assigned only after the tree it commits to has been validated, so it
    // always names a commitment tx this handler has checked.
    let validatedCommitmentTxid: string | undefined;

    return {
        onBatchStarted: async (event: BatchStartedEvent): Promise<{ skip: boolean }> => {
            const utf8IntentId = new TextEncoder().encode(intentId);
            const intentIdHash = sha256(utf8IntentId);
            const intentIdHashStr = hex.encode(intentIdHash);

            if (!event.intentIdHashes.includes(intentIdHashStr)) return { skip: true };

            const info = await arkProvider.getInfo();
            // Bound the expiry before confirming, so a rejected round is never
            // confirmed to the operator.
            const timelock = assertValidBatchExpiry(
                event.batchExpiry,
                resolveBatchExpiryPolicy(network, {
                    advertisedVtxoTreeExpiry: info.vtxoTreeExpiry,
                    ...batchExpiryPolicy,
                }),
            );

            await arkProvider.confirmRegistration(intentId);

            batchId = event.id;

            const sweepTapscript = CSVMultisigTapscript.encode({
                timelock,
                pubkeys: [toXOnly(hex.decode(info.forfeitPubkey), "forfeit key")],
            }).script;

            sweepTapTreeRoot = tapLeafHash(sweepTapscript);
            return { skip: false };
        },

        onTreeSigningStarted: async (
            event: TreeSigningStartedEvent,
            vtxoTree: TxTree,
        ): Promise<{ skip: boolean }> => {
            const signerPubKey = await session.getPublicKey();
            const xonlySignerPubKey = toXOnly(signerPubKey, "signer key");
            const xOnlyPubkeys = event.cosignersPublicKeys.map((k) =>
                hex.encode(toXOnly(hex.decode(k), "cosigner key")),
            );

            if (!xOnlyPubkeys.includes(hex.encode(xonlySignerPubKey))) {
                return { skip: true };
            }

            const commitmentTx = Transaction.fromPSBT(base64.decode(event.unsignedCommitmentTx));

            validateVtxoTxGraph(vtxoTree, commitmentTx, sweepTapTreeRoot);

            // validate that all expected receivers are in the virtual output
            // tree with correct amounts and assets
            if (recipients && recipients.length > 0) {
                validateBatchRecipients(commitmentTx, vtxoTree.leaves(), recipients, network);
            }

            const sharedOutput = commitmentTx.getOutput(0);
            if (!sharedOutput?.amount) {
                throw new Error("Shared output not found");
            }

            validatedCommitmentTxid = commitmentTx.id;

            await session.init(vtxoTree, sweepTapTreeRoot, sharedOutput.amount);

            const pubkey = hex.encode(await session.getPublicKey());
            const nonces = await session.getNonces();
            await arkProvider.submitTreeNonces(batchId, pubkey, nonces);

            return { skip: false };
        },

        onTreeNonces: async (event: TreeNoncesEvent): Promise<{ fullySigned: boolean }> => {
            const { hasAllNonces } = await session.aggregatedNonces(event.txid, event.nonces);

            if (!hasAllNonces) return { fullySigned: false };

            const signatures = await session.sign();
            const pubkey = hex.encode(await session.getPublicKey());
            await arkProvider.submitTreeSignatures(batchId, pubkey, signatures);

            return { fullySigned: true };
        },

        onBatchFinalization: async (
            event: BatchFinalizationEvent,
            _vtxoTree?: TxTree,
            connectorTree?: TxTree,
        ): Promise<void> => {
            const info = await arkProvider.getInfo();
            const forfeitOutputScript = OutScript.encode(
                Address(network).decode(info.forfeitAddress),
            );

            if (connectorTree) {
                validateConnectorsTxGraph(event.commitmentTx, connectorTree);
            }

            let commitmentPsbt = Transaction.fromPSBT(base64.decode(event.commitmentTx));
            assertFinalCommitmentMatchesValidated(
                commitmentPsbt,
                validatedCommitmentTxid,
                "arkade batch finalization",
            );

            // No validated txid means tree signing never ran, so the recipients
            // have not been checked yet and this commitment tx is the only thing
            // to check them against. Before any signature is handed over.
            if (!validatedCommitmentTxid && recipients && recipients.length > 0) {
                validateBatchRecipientsWithoutTree(commitmentPsbt, recipients, network);
            }
            const signedForfeits: string[] = [];
            let connectorIndex = 0;
            const connectorLeaves = connectorTree?.leaves() || [];

            const boardingIndices: number[] = [];

            for (const input of inputs) {
                if (!isVtxoCoin(input)) {
                    let boardingIdx: number | null = null;
                    for (let i = 0; i < commitmentPsbt.inputsLength; i++) {
                        const psbtInput = commitmentPsbt.getInput(i);
                        if (!psbtInput.txid) continue;
                        if (
                            hex.encode(psbtInput.txid) === input.txid &&
                            psbtInput.index === input.vout
                        ) {
                            boardingIdx = i;
                            break;
                        }
                    }

                    if (boardingIdx === null) {
                        // Either the server left a registered boarding input out of the
                        // commitment tx, or this is a virtual output that reached us without
                        // `script` and so read as boarding. Both settle without the forfeit
                        // the server expects, which surfaces as an opaque `Bad Request` from
                        // `submitSignedForfeitTxs` — name the input here instead.
                        throw new Error(
                            `input ${input.txid}:${input.vout} is neither a virtual output nor ` +
                                `an input of the commitment tx; a virtual output must carry its ` +
                                `\`script\``,
                        );
                    }

                    commitmentPsbt.updateInput(boardingIdx, {
                        tapLeafScript: [input.forfeitTapLeafScript],
                    });
                    boardingIndices.push(boardingIdx);
                    continue;
                }

                // Recoverable or subdust VTXOs don't require a forfeit tx
                if (
                    canRecoverOnchain(input, { timestamp: new Date() }) ||
                    isSubdust(input, info.dust)
                ) {
                    continue;
                }

                // Settlement: build forfeit from connector leaf
                if (connectorIndex >= connectorLeaves.length) {
                    throw new Error("not enough connectors received");
                }

                const connectorLeaf = connectorLeaves[connectorIndex++];
                const connectorTxId = connectorLeaf.id;
                const connectorOutput = connectorLeaf.getOutput(0);
                if (!connectorOutput?.amount || !connectorOutput?.script) {
                    throw new Error(
                        `Invalid connector output at index ${connectorIndex - 1}: missing amount or script`,
                    );
                }

                let forfeitTx = buildForfeitTx(
                    [
                        {
                            txid: input.txid,
                            index: input.vout,
                            witnessUtxo: {
                                amount: BigInt(input.value),
                                script: VtxoScript.decode(input.tapTree).pkScript,
                            },
                            sighashType: SigHash.DEFAULT,
                            tapLeafScript: [input.forfeitTapLeafScript],
                        },
                        {
                            txid: connectorTxId,
                            index: 0,
                            witnessUtxo: {
                                amount: connectorOutput.amount,
                                script: connectorOutput.script,
                            },
                        },
                    ],
                    forfeitOutputScript,
                );

                forfeitTx = await signer.sign(forfeitTx, [0]);
                signedForfeits.push(base64.encode(forfeitTx.toPSBT()));
            }

            // Sign boarding inputs on the commitment tx
            // The emulator already knows the arkade scripts from the intent proof,
            // so we don't modify the commitment tx outputs (which would change the txid).
            if (boardingIndices.length > 0) {
                commitmentPsbt = await signer.sign(commitmentPsbt, boardingIndices);
            }

            // Build connector tree nodes for the emulator
            let connectorTreeNodes: ConnectorTreeNode[] | null = null;
            if (connectorTree) {
                connectorTreeNodes = [];
                for (const subtree of connectorTree.iterator()) {
                    const children: Record<string, string> = {};
                    for (const [outputIndex, child] of subtree.children) {
                        children[String(outputIndex)] = child.txid;
                    }
                    connectorTreeNodes.push({
                        txid: subtree.txid,
                        tx: base64.encode(subtree.root.toPSBT()),
                        children,
                    });
                }
            }

            const hasBoardingInputs = boardingIndices.length > 0;
            const commitmentB64 = hasBoardingInputs
                ? base64.encode(commitmentPsbt.toPSBT())
                : event.commitmentTx;

            // Submit to the emulator for counter-signing
            const emuResult = await emulator.submitFinalization(
                { proof: signedProof, message },
                signedForfeits,
                connectorTreeNodes,
                commitmentB64,
            );

            // Submit to server
            await arkProvider.submitSignedForfeitTxs(
                emuResult.signedForfeits,
                emuResult.signedCommitmentTx || (hasBoardingInputs ? commitmentB64 : undefined),
            );
        },
    };
}
