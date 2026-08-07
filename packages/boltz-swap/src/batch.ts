import {
    ArkProvider,
    BatchFinalizationEvent,
    BatchStartedEvent,
    CSVMultisigTapscript,
    Network,
    Recipient,
    SignerSession,
    Transaction,
    TreeNoncesEvent,
    TreeSigningStartedEvent,
    TxTree,
    validateVtxoTxGraph,
    validateConnectorsTxGraph,
    validateBatchRecipients,
    assertFinalCommitmentMatchesValidated,
    Identity,
    VtxoScript,
    buildForfeitTx,
    ArkTxInput,
    getSequence,
    assertValidBatchExpiry,
    resolveBatchExpiryPolicy,
    type BatchExpiryPolicy,
} from "@arkade-os/sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64, hex } from "@scure/base";
import { SigHash } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { Bytes } from "@scure/btc-signer/utils.js";

export function createVHTLCBatchHandler(
    intentId: string,
    vhtlc: ArkTxInput,
    arkProvider: ArkProvider,
    identity: Identity,
    session: SignerSession,
    sweepPublicKey: Uint8Array,
    network: Network,
    recipient?: Recipient,
    forfeitOutputScript?: Bytes, // undefined if recoverable
    connectorIndex: number = 0,
    /** Overrides for the `batchExpiry` bounds; defaults derive from `network`. */
    batchExpiryPolicy?: Partial<BatchExpiryPolicy>,
) {
    const utf8IntentId = new TextEncoder().encode(intentId);
    const intentIdHash = sha256(utf8IntentId);
    const intentIdHashStr = hex.encode(intentIdHash);

    let sweepTapTreeRoot: Uint8Array | undefined;
    let validatedCommitmentTxid: string | undefined;

    return {
        onBatchStarted: async (event: BatchStartedEvent): Promise<{ skip: boolean }> => {
            // check if our intent ID hash matches any in the event
            const skip = !event.intentIdHashes.includes(intentIdHashStr);

            if (skip) {
                return { skip };
            }

            if (!arkProvider) {
                throw new Error("Ark provider not configured");
            }

            // Bound the expiry before confirming, so a rejected round is never
            // confirmed to the operator.
            const timelock = assertValidBatchExpiry(
                event.batchExpiry,
                resolveBatchExpiryPolicy(network, batchExpiryPolicy),
            );

            await arkProvider.confirmRegistration(intentId);

            const sweepTapscript = CSVMultisigTapscript.encode({
                timelock,
                pubkeys: [sweepPublicKey],
            }).script;

            sweepTapTreeRoot = tapLeafHash(sweepTapscript);

            return { skip: false };
        },
        onTreeSigningStarted: async (
            event: TreeSigningStartedEvent,
            vtxoTree: TxTree,
        ): Promise<{ skip: boolean }> => {
            if (!session) {
                return { skip: true };
            }
            if (!sweepTapTreeRoot) {
                throw new Error("Sweep tap tree root not set");
            }

            const xOnlyPublicKeys = event.cosignersPublicKeys.map((k) => k.slice(2));
            const signerPublicKey = await session.getPublicKey();
            const xonlySignerPublicKey = signerPublicKey.subarray(1);

            if (!xOnlyPublicKeys.includes(hex.encode(xonlySignerPublicKey))) {
                // not a cosigner, skip the signing
                return { skip: true };
            }

            // validate the unsigned vtxo tree
            const commitmentTx = Transaction.fromPSBT(base64.decode(event.unsignedCommitmentTx));
            validateVtxoTxGraph(vtxoTree, commitmentTx, sweepTapTreeRoot);

            if (recipient) {
                validateBatchRecipients(commitmentTx, vtxoTree.leaves(), [recipient], network);
            }
            // record only after validation so a rejected tree never pins a txid
            validatedCommitmentTxid = commitmentTx.id;

            const sharedOutput = commitmentTx.getOutput(0);
            if (!sharedOutput?.amount) {
                throw new Error("Shared output not found");
            }

            await session.init(vtxoTree, sweepTapTreeRoot, sharedOutput.amount);

            const pubkey = hex.encode(await session.getPublicKey());
            const nonces = await session.getNonces();

            await arkProvider.submitTreeNonces(event.id, pubkey, nonces);

            return { skip: false };
        },
        onTreeNonces: async (event: TreeNoncesEvent): Promise<{ fullySigned: boolean }> => {
            if (!session) {
                return { fullySigned: true }; // Signing complete (no signing needed)
            }

            const { hasAllNonces } = await session.aggregatedNonces(event.txid, event.nonces);

            // wait to receive and aggregate all nonces before sending signatures
            if (!hasAllNonces) return { fullySigned: false };

            const signatures = await session.sign();
            const pubkey = hex.encode(await session.getPublicKey());

            await arkProvider.submitTreeSignatures(event.id, pubkey, signatures);
            return { fullySigned: true };
        },
        onBatchFinalization: async (
            event: BatchFinalizationEvent,
            _?: TxTree,
            connectorTree?: TxTree,
        ): Promise<void> => {
            if (!forfeitOutputScript) {
                // no need to create a forfeit transaction, skip
                return;
            }

            // this handler always cosigns the tree (no skipVtxoTreeSigning path),
            // so a finalization without a pinned commitment tx is protocol-invalid
            if (!validatedCommitmentTxid) {
                throw new Error(
                    "BatchFinalizationEvent: commitment tx was not validated at tree signing",
                );
            }
            assertFinalCommitmentMatchesValidated(
                Transaction.fromPSBT(base64.decode(event.commitmentTx)),
                validatedCommitmentTxid,
                "vhtlc batch finalization",
            );

            if (!connectorTree) {
                throw new Error("BatchFinalizationEvent: expected connector tree to be defined");
            }

            validateConnectorsTxGraph(event.commitmentTx, connectorTree);
            const connectors = connectorTree.leaves();
            if (connectors.length <= connectorIndex) {
                throw new Error(
                    `BatchFinalizationEvent: expected connector tree has ${connectors.length} leaves, expected at least ${connectorIndex + 1}`,
                );
            }
            const forfeitTx = createForfeitTx(
                vhtlc,
                forfeitOutputScript,
                connectors[connectorIndex],
            );
            const signedForfeitTx = await identity.sign(forfeitTx);
            await arkProvider.submitSignedForfeitTxs([base64.encode(signedForfeitTx.toPSBT())]);
        },
    };
}

function createForfeitTx(
    input: ArkTxInput,
    forfeitOutputScript: Bytes,
    connector: Transaction,
): Transaction {
    const connectorTxId = connector.id;
    const connectorOutput = connector.getOutput(0);
    if (!connectorOutput) {
        throw new Error("connector output not found");
    }

    const connectorAmount = connectorOutput.amount;
    const connectorPkScript = connectorOutput.script;

    if (!connectorAmount || !connectorPkScript) {
        throw new Error("invalid connector output");
    }

    const sequence = getSequence(input.tapLeafScript);

    return buildForfeitTx(
        [
            {
                txid: input.txid,
                index: input.vout,
                witnessUtxo: {
                    amount: BigInt(input.value),
                    script: VtxoScript.decode(input.tapTree).pkScript,
                },
                sighashType: SigHash.DEFAULT,
                tapLeafScript: [input.tapLeafScript],
                sequence,
            },
            {
                txid: connectorTxId,
                index: 0,
                witnessUtxo: {
                    amount: connectorAmount,
                    script: connectorPkScript,
                },
            },
        ],
        forfeitOutputScript,
        sequence,
    );
}
