/**
 * Arkade Batch Handler
 *
 * Factory function that creates a `Batch.Handler` for arkade-script
 * transactions with introspector co-signing. Handles both on-chain
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
import type {
    IntrospectorProvider,
    ConnectorTreeNode,
} from "../providers/introspector";
import type { Network } from "../networks";
import type { ExtendedCoin } from "../wallet";
import type { SignerSession } from "../tree/signingSession";
import type {
    BatchStartedEvent,
    TreeSigningStartedEvent,
    TreeNoncesEvent,
    BatchFinalizationEvent,
} from "../providers/ark";

import { VtxoScript } from "../script/base";
import { CSVMultisigTapscript } from "../script/tapscript";
import { Transaction } from "../utils/transaction";
import { setArkPsbtField, ArkadeScriptField } from "../utils/unknownFields";
import { buildForfeitTx } from "../forfeit";
import { Batch } from "../wallet/batch";
import { Intent } from "../intent";
import type { TxTree } from "../tree/txTree";

export type ArkadeExtendedCoin = ExtendedCoin & {
    arkadeScriptBytes: Uint8Array;
};

export function createArkadeBatchHandler(
    intentId: string,
    inputs: ArkadeExtendedCoin[],
    signer: Identity,
    signedProof: string,
    message: Intent.RegisterMessage,
    session: SignerSession,
    arkProvider: ArkProvider,
    introspector: IntrospectorProvider,
    network: Network
): Batch.Handler {
    let batchId: string;
    let sweepTapTreeRoot: Uint8Array;

    return {
        onBatchStarted: async (
            event: BatchStartedEvent
        ): Promise<{ skip: boolean }> => {
            const utf8IntentId = new TextEncoder().encode(intentId);
            const intentIdHash = sha256(utf8IntentId);
            const intentIdHashStr = hex.encode(intentIdHash);

            let skip = true;
            for (const idHash of event.intentIdHashes) {
                if (idHash === intentIdHashStr) {
                    await arkProvider.confirmRegistration(intentId);
                    skip = false;
                    break;
                }
            }

            if (skip) return { skip };

            batchId = event.id;

            const sweepTapscript = CSVMultisigTapscript.encode({
                timelock: {
                    value: event.batchExpiry,
                    // BIP-65: values >= 512 are interpreted as seconds, below as blocks
                    type: event.batchExpiry >= 512n ? "seconds" : "blocks",
                },
                pubkeys: [
                    hex
                        .decode((await arkProvider.getInfo()).forfeitPubkey)
                        .subarray(1),
                ],
            }).script;

            sweepTapTreeRoot = tapLeafHash(sweepTapscript);
            return { skip: false };
        },

        onTreeSigningStarted: async (
            event: TreeSigningStartedEvent,
            vtxoTree: TxTree
        ): Promise<{ skip: boolean }> => {
            const signerPubKey = await session.getPublicKey();
            const xonlySignerPubKey = signerPubKey.subarray(1);
            const xOnlyPubkeys = event.cosignersPublicKeys.map((k) =>
                k.slice(2)
            );

            if (!xOnlyPubkeys.includes(hex.encode(xonlySignerPubKey))) {
                return { skip: true };
            }

            const commitmentTx = Transaction.fromPSBT(
                base64.decode(event.unsignedCommitmentTx)
            );
            const sharedOutput = commitmentTx.getOutput(0);
            if (!sharedOutput?.amount) {
                throw new Error("Shared output not found");
            }

            await session.init(vtxoTree, sweepTapTreeRoot, sharedOutput.amount);

            const pubkey = hex.encode(await session.getPublicKey());
            const nonces = await session.getNonces();
            await arkProvider.submitTreeNonces(batchId, pubkey, nonces);

            return { skip: false };
        },

        onTreeNonces: async (
            event: TreeNoncesEvent
        ): Promise<{ fullySigned: boolean }> => {
            const { hasAllNonces } = await session.aggregatedNonces(
                event.txid,
                event.nonces
            );

            if (!hasAllNonces) return { fullySigned: false };

            const signatures = await session.sign();
            const pubkey = hex.encode(await session.getPublicKey());
            await arkProvider.submitTreeSignatures(batchId, pubkey, signatures);

            return { fullySigned: true };
        },

        onBatchFinalization: async (
            event: BatchFinalizationEvent,
            _vtxoTree?: TxTree,
            connectorTree?: TxTree
        ): Promise<void> => {
            const info = await arkProvider.getInfo();
            const forfeitOutputScript = OutScript.encode(
                Address(network).decode(info.forfeitAddress)
            );

            let commitmentPsbt = Transaction.fromPSBT(
                base64.decode(event.commitmentTx)
            );
            const signedForfeits: string[] = [];
            let hasBoardingInputs = false;
            let connectorIndex = 0;
            const connectorLeaves = connectorTree?.leaves() || [];

            for (const input of inputs) {
                // Auto-detect: is this input in the commitment tx? (boarding)
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

                if (boardingIdx !== null) {
                    // Boarding: sign commitment tx directly
                    commitmentPsbt.updateInput(boardingIdx, {
                        tapLeafScript: [input.forfeitTapLeafScript],
                    });

                    setArkPsbtField(
                        commitmentPsbt,
                        boardingIdx,
                        ArkadeScriptField,
                        input.arkadeScriptBytes
                    );

                    commitmentPsbt = await signer.sign(commitmentPsbt, [
                        boardingIdx,
                    ]);
                    hasBoardingInputs = true;
                } else {
                    // Settlement: build forfeit from connector leaf
                    if (connectorIndex >= connectorLeaves.length) {
                        throw new Error("not enough connectors received");
                    }

                    const connectorLeaf = connectorLeaves[connectorIndex++];
                    const connectorTxId = connectorLeaf.id;
                    const connectorOutput = connectorLeaf.getOutput(0);
                    if (!connectorOutput?.amount || !connectorOutput?.script) {
                        continue;
                    }

                    let forfeitTx = buildForfeitTx(
                        [
                            {
                                txid: input.txid,
                                index: input.vout,
                                witnessUtxo: {
                                    amount: BigInt(input.value),
                                    script: VtxoScript.decode(input.tapTree)
                                        .pkScript,
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
                        forfeitOutputScript
                    );

                    setArkPsbtField(
                        forfeitTx,
                        0,
                        ArkadeScriptField,
                        input.arkadeScriptBytes
                    );

                    forfeitTx = await signer.sign(forfeitTx, [0]);
                    signedForfeits.push(base64.encode(forfeitTx.toPSBT()));
                }
            }

            // Build connector tree nodes for introspector
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

            const commitmentB64 = hasBoardingInputs
                ? base64.encode(commitmentPsbt.toPSBT())
                : event.commitmentTx;

            // Submit to introspector for counter-signing
            const introResult = await introspector.submitFinalization(
                { proof: signedProof, message },
                signedForfeits,
                connectorTreeNodes,
                commitmentB64
            );

            // Submit to server
            await arkProvider.submitSignedForfeitTxs(
                introResult.signedForfeits,
                introResult.signedCommitmentTx ||
                    (hasBoardingInputs ? commitmentB64 : undefined)
            );
        },
    };
}
