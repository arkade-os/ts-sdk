import {
    ArkProvider,
    BatchFinalizationEvent,
    BatchStartedEvent,
    CSVMultisigTapscript,
    SignerSession,
    Transaction,
    TreeNoncesEvent,
    TreeSigningStartedEvent,
    TxTree,
    validateVtxoTxGraph,
    validateConnectorsTxGraph,
    Identity,
    VtxoScript,
    buildForfeitTx,
    ArkTxInput,
    getSequence,
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
    forfeitOutputScript?: Bytes, // undefined if recoverable
    connectorIndex: number = 0
) {
    const utf8IntentId = new TextEncoder().encode(intentId);
    const intentIdHash = sha256(utf8IntentId);
    const intentIdHashStr = hex.encode(intentIdHash);

    let sweepTapTreeRoot: Uint8Array | undefined;

    return {
        onBatchStarted: async (
            event: BatchStartedEvent
        ): Promise<{ skip: boolean }> => {
            let skip = true;

            // check if our intent ID hash matches any in the event
            for (const idHash of event.intentIdHashes) {
                if (idHash === intentIdHashStr) {
                    if (!arkProvider) {
                        throw new Error("Ark provider not configured");
                    }
                    await arkProvider.confirmRegistration(intentId);
                    skip = false;
                }
            }

            if (skip) {
                return { skip };
            }

            const sweepTapscript = CSVMultisigTapscript.encode({
                timelock: {
                    value: event.batchExpiry,
                    type: event.batchExpiry >= 512n ? "seconds" : "blocks",
                },
                pubkeys: [sweepPublicKey],
            }).script;

            sweepTapTreeRoot = tapLeafHash(sweepTapscript);

            return { skip: false };
        },
        onTreeSigningStarted: async (
            event: TreeSigningStartedEvent,
            vtxoTree: TxTree
        ): Promise<{ skip: boolean }> => {
            if (!session) {
                return { skip: true };
            }
            if (!sweepTapTreeRoot) {
                throw new Error("Sweep tap tree root not set");
            }

            const xOnlyPublicKeys = event.cosignersPublicKeys.map((k) =>
                k.slice(2)
            );
            const signerPublicKey = await session.getPublicKey();
            const xonlySignerPublicKey = signerPublicKey.subarray(1);

            if (!xOnlyPublicKeys.includes(hex.encode(xonlySignerPublicKey))) {
                // not a cosigner, skip the signing
                return { skip: true };
            }

            // validate the unsigned vtxo tree
            const commitmentTx = Transaction.fromPSBT(
                base64.decode(event.unsignedCommitmentTx)
            );
            validateVtxoTxGraph(vtxoTree, commitmentTx, sweepTapTreeRoot);

            // TODO check if our registered outputs are in the vtxo tree

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
        onTreeNonces: async (
            event: TreeNoncesEvent
        ): Promise<{ fullySigned: boolean }> => {
            if (!session) {
                return { fullySigned: true }; // Signing complete (no signing needed)
            }

            const { hasAllNonces } = await session.aggregatedNonces(
                event.txid,
                event.nonces
            );

            // wait to receive and aggregate all nonces before sending signatures
            if (!hasAllNonces) return { fullySigned: false };

            const signatures = await session.sign();
            const pubkey = hex.encode(await session.getPublicKey());

            await arkProvider.submitTreeSignatures(
                event.id,
                pubkey,
                signatures
            );
            return { fullySigned: true };
        },
        onBatchFinalization: async (
            event: BatchFinalizationEvent,
            _?: TxTree,
            connectorTree?: TxTree
        ): Promise<void> => {
            if (!forfeitOutputScript) {
                // no need to create a forfeit transaction, skip
                return;
            }

            if (!connectorTree) {
                throw new Error(
                    "BatchFinalizationEvent: expected connector tree to be defined"
                );
            }

            validateConnectorsTxGraph(event.commitmentTx, connectorTree);
            const connectors = connectorTree.leaves();
            if (connectors.length <= connectorIndex) {
                throw new Error(
                    `BatchFinalizationEvent: expected connector tree has ${connectors.length} leaves, expected at least ${connectorIndex + 1}`
                );
            }
            const forfeitTx = createForfeitTx(
                vhtlc,
                forfeitOutputScript,
                connectors[connectorIndex]
            );
            const signedForfeitTx = await identity.sign(forfeitTx);
            await arkProvider.submitSignedForfeitTxs([
                base64.encode(signedForfeitTx.toPSBT()),
            ]);
        },
    };
}

function createForfeitTx(
    input: ArkTxInput,
    forfeitOutputScript: Bytes,
    connector: Transaction
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
        sequence
    );
}
