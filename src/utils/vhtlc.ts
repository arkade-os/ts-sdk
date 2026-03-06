import {
    ArkInfo,
    ArkProvider,
    ArkTxInput,
    Batch,
    buildOffchainTx,
    getSequence,
    Identity,
    Intent,
    networks,
    TapLeafScript,
    VHTLC,
    VtxoScript,
    VtxoTaprootTree,
    CSVMultisigTapscript,
    combineTapscriptSigs,
} from "@arkade-os/sdk";
import { logger } from "../logger";
import { hex, base64 } from "@scure/base";
import { createVHTLCBatchHandler } from "../batch";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { Address, OutScript, Transaction } from "@scure/btc-signer";
import { normalizeToXOnlyKey, verifySignatures } from "./signatures";
import { TransactionOutput, TransactionInput } from "@scure/btc-signer/psbt.js";

/**
 * Creates a VHTLC script for the swap.
 * Works for submarine, reverse, and chain swaps.
 * It creates a VHTLC script that can be used to claim or refund the swap.
 * It validates the receiver, sender, and server public keys are x-only.
 * @param args - The parameters for creating the VHTLC script.
 * @param args.preimageHash - The SHA256 digest of the preimage (not the raw preimage or RIPEMD160 hash).
 * The function will apply ripemd160(preimageHash) internally to create the final commitment.
 * @returns The created VHTLC script and address.
 */
export const createVHTLCScript = (args: {
    network: string;
    preimageHash: Uint8Array;
    receiverPubkey: string;
    senderPubkey: string;
    serverPubkey: string;
    timeoutBlockHeights: {
        refund: number;
        unilateralClaim: number;
        unilateralRefund: number;
        unilateralRefundWithoutReceiver: number;
    };
}): { vhtlcScript: VHTLC.Script; vhtlcAddress: string } => {
    const {
        network,
        preimageHash,
        receiverPubkey,
        senderPubkey,
        serverPubkey,
        timeoutBlockHeights,
    } = args;
    // validate we are using a x-only receiver public key
    const receiverXOnlyPublicKey = normalizeToXOnlyKey(
        hex.decode(receiverPubkey),
        "receiver"
    );

    // validate we are using a x-only sender public key
    const senderXOnlyPublicKey = normalizeToXOnlyKey(
        hex.decode(senderPubkey),
        "sender"
    );

    // validate we are using a x-only server public key
    const serverXOnlyPublicKey = normalizeToXOnlyKey(
        hex.decode(serverPubkey),
        "server"
    );

    const delayType = (num: number) => (num < 512 ? "blocks" : "seconds");

    const vhtlcScript = new VHTLC.Script({
        preimageHash: ripemd160(preimageHash),
        sender: senderXOnlyPublicKey,
        receiver: receiverXOnlyPublicKey,
        server: serverXOnlyPublicKey,
        refundLocktime: BigInt(timeoutBlockHeights.refund),
        unilateralClaimDelay: {
            type: delayType(timeoutBlockHeights.unilateralClaim),
            value: BigInt(timeoutBlockHeights.unilateralClaim),
        },
        unilateralRefundDelay: {
            type: delayType(timeoutBlockHeights.unilateralRefund),
            value: BigInt(timeoutBlockHeights.unilateralRefund),
        },
        unilateralRefundWithoutReceiverDelay: {
            type: delayType(
                timeoutBlockHeights.unilateralRefundWithoutReceiver
            ),
            value: BigInt(timeoutBlockHeights.unilateralRefundWithoutReceiver),
        },
    });

    if (!vhtlcScript.claimScript)
        throw new Error("Failed to create VHTLC script");

    // validate vhtlc script
    const hrp = network === "bitcoin" ? "ark" : "tark";
    const vhtlcAddress = vhtlcScript
        .address(hrp, serverXOnlyPublicKey)
        .encode();

    return { vhtlcScript, vhtlcAddress };
};

/**
 * Joins a batch to spend the vtxo via commitment transaction
 * @param identity - The identity to use for signing the forfeit transaction.
 * @param input - The input vtxo.
 * @param output - The output script.
 * @param forfeitPublicKey - The forfeit public key.
 * @returns The commitment transaction ID.
 */
export const joinBatch = async (
    arkProvider: ArkProvider,
    identity: Identity,
    input: ArkTxInput,
    output: TransactionOutput,
    {
        forfeitPubkey,
        forfeitAddress,
        network,
    }: Pick<ArkInfo, "forfeitPubkey" | "forfeitAddress" | "network">,
    isRecoverable = true
): Promise<string> => {
    const signerSession = identity.signerSession();
    const signerPublicKey = await signerSession.getPublicKey();

    const intentMessage: Intent.RegisterMessage = {
        type: "register",
        onchain_output_indexes: [],
        valid_at: 0,
        expire_at: 0,
        cosigners_public_keys: [hex.encode(signerPublicKey)],
    };

    const deleteMessage: Intent.DeleteMessage = {
        type: "delete",
        expire_at: 0,
    };

    const intentInput: TransactionInput = {
        txid: hex.decode(input.txid),
        index: input.vout,
        witnessUtxo: {
            amount: BigInt(input.value),
            script: VtxoScript.decode(input.tapTree).pkScript,
        },
        tapLeafScript: [input.tapLeafScript],
        unknown: [VtxoTaprootTree.encode(input.tapTree)],
        sequence: getSequence(input.tapLeafScript),
    };

    const registerIntent = Intent.create(
        intentMessage,
        [intentInput],
        [output]
    );
    const deleteIntent = Intent.create(deleteMessage, [intentInput]);

    const [signedRegisterIntent, signedDeleteIntent] = await Promise.all([
        identity.sign(registerIntent),
        identity.sign(deleteIntent),
    ]);

    const abortController = new AbortController();

    const intentId = await arkProvider.registerIntent({
        message: intentMessage,
        proof: base64.encode(signedRegisterIntent.toPSBT()),
    });

    const decodedAddress = Address(
        network in networks
            ? networks[network as keyof typeof networks]
            : networks.bitcoin
    ).decode(forfeitAddress);

    try {
        const handler = createVHTLCBatchHandler(
            intentId,
            input,
            arkProvider,
            identity,
            signerSession,
            normalizeToXOnlyKey(forfeitPubkey, "forfeit"),
            isRecoverable ? undefined : OutScript.encode(decodedAddress)
        );

        const topics = [
            hex.encode(signerPublicKey),
            `${input.txid}:${input.vout}`,
        ];
        const eventStream = arkProvider.getEventStream(
            abortController.signal,
            topics
        );

        const commitmentTxid = await Batch.join(eventStream, handler, {
            abortController,
        });
        return commitmentTxid;
    } catch (error) {
        abortController.abort();
        logger.error("Failed to join batch:", error);
        try {
            await arkProvider.deleteIntent({
                message: deleteMessage,
                proof: base64.encode(signedDeleteIntent.toPSBT()),
            });
        } catch (error) {
            logger.error("Failed to delete intent:", error);
        }
        throw error;
    }
};

/**
 * Claims a VHTLC using an offchain transaction.
 * @param identity
 * @param vhtlcScript
 * @param serverXOnlyPublicKey
 * @param input
 * @param output
 * @param arkInfo
 * @param arkProvider
 */
export const claimVHTLCwithOffchainTx = async (
    identity: Identity,
    vhtlcScript: VHTLC.Script,
    serverXOnlyPublicKey: Uint8Array,
    input: ArkTxInput,
    output: TransactionOutput,
    arkInfo: ArkInfo,
    arkProvider: ArkProvider
): Promise<void> => {
    // create the server unroll script for checkpoint transactions
    const rawCheckpointTapscript = hex.decode(arkInfo.checkpointTapscript);
    const serverUnrollScript = CSVMultisigTapscript.decode(
        rawCheckpointTapscript
    );

    // create the offchain transaction to claim the VHTLC
    const { arkTx, checkpoints } = buildOffchainTx(
        [input],
        [output],
        serverUnrollScript
    );

    // sign and submit the virtual transaction
    const signedArkTx = await identity.sign(arkTx);
    const { arkTxid, finalArkTx, signedCheckpointTxs } =
        await arkProvider.submitTx(
            base64.encode(signedArkTx.toPSBT()),
            checkpoints.map((c) => base64.encode(c.toPSBT()))
        );

    // verify the server signed the transaction with correct key
    if (
        !validFinalArkTx(finalArkTx, serverXOnlyPublicKey, vhtlcScript.leaves)
    ) {
        throw new Error("Invalid final Ark transaction");
    }

    // sign the checkpoint transactions pre signed by the server
    const finalCheckpoints = await Promise.all(
        signedCheckpointTxs.map(async (c) => {
            const tx = Transaction.fromPSBT(base64.decode(c), {
                allowUnknown: true,
            });
            const signedCheckpoint = await identity.sign(tx, [0]);
            return base64.encode(signedCheckpoint.toPSBT());
        })
    );

    // submit the final transaction to the Ark provider
    await arkProvider.finalizeTx(arkTxid, finalCheckpoints);
};

/**
 * Refunds a VHTLC using an offchain transaction.
 * @param swapId
 * @param identity
 * @param arkProvider
 * @param boltzXOnlyPublicKey
 * @param ourXOnlyPublicKey
 * @param serverXOnlyPublicKey
 * @param input
 * @param output
 * @param arkInfo
 * @param refundFunc
 */
export const refundVHTLCwithOffchainTx = async (
    swapId: string,
    identity: Identity,
    arkProvider: ArkProvider,
    boltzXOnlyPublicKey: Uint8Array,
    ourXOnlyPublicKey: Uint8Array,
    serverXOnlyPublicKey: Uint8Array,
    input: ArkTxInput,
    output: TransactionOutput,
    arkInfo: ArkInfo,
    refundFunc: (
        swapId: string,
        unsignedRefundTx: Transaction,
        unsignedCheckpointTx: Transaction
    ) => Promise<{
        transaction: Transaction;
        checkpoint: Transaction;
    }>
): Promise<void> => {
    // create the server unroll script for checkpoint transactions
    const rawCheckpointTapscript = hex.decode(arkInfo.checkpointTapscript);
    const serverUnrollScript = CSVMultisigTapscript.decode(
        rawCheckpointTapscript
    );

    // create the virtual transaction to claim the VHTLC
    const { arkTx: unsignedRefundTx, checkpoints: checkpointPtxs } =
        buildOffchainTx([input], [output], serverUnrollScript);

    // validate we have one checkpoint transaction
    if (checkpointPtxs.length !== 1)
        throw new Error(
            `Expected one checkpoint transaction, got ${checkpointPtxs.length}`
        );

    const unsignedCheckpointTx = checkpointPtxs[0];

    // get Boltz to sign its part
    const {
        transaction: boltzSignedRefundTx,
        checkpoint: boltzSignedCheckpointTx,
    } = await refundFunc(swapId, unsignedRefundTx, unsignedCheckpointTx);

    // Verify Boltz signatures before combining
    const boltzXOnlyPublicKeyHex = hex.encode(boltzXOnlyPublicKey);
    if (!verifySignatures(boltzSignedRefundTx, 0, [boltzXOnlyPublicKeyHex])) {
        throw new Error("Invalid Boltz signature in refund transaction");
    }
    if (
        !verifySignatures(boltzSignedCheckpointTx, 0, [boltzXOnlyPublicKeyHex])
    ) {
        throw new Error("Invalid Boltz signature in checkpoint transaction");
    }

    // sign our part
    const signedRefundTx = await identity.sign(unsignedRefundTx);
    const signedCheckpointTx = await identity.sign(unsignedCheckpointTx);

    // combine transactions
    const combinedSignedRefundTx = combineTapscriptSigs(
        boltzSignedRefundTx,
        signedRefundTx
    );
    const combinedSignedCheckpointTx = combineTapscriptSigs(
        boltzSignedCheckpointTx,
        signedCheckpointTx
    );

    // get server to sign its part of the combined transaction
    const { arkTxid, finalArkTx, signedCheckpointTxs } =
        await arkProvider.submitTx(
            base64.encode(combinedSignedRefundTx.toPSBT()),
            [base64.encode(unsignedCheckpointTx.toPSBT())]
        );

    // verify the final tx is properly signed
    const tx = Transaction.fromPSBT(base64.decode(finalArkTx));
    const inputIndex = 0;
    const requiredSigners = [
        hex.encode(ourXOnlyPublicKey),
        hex.encode(boltzXOnlyPublicKey),
        hex.encode(serverXOnlyPublicKey),
    ];

    if (!verifySignatures(tx, inputIndex, requiredSigners)) {
        throw new Error("Invalid refund transaction");
    }

    // validate we received exactly one checkpoint transaction
    if (signedCheckpointTxs.length !== 1) {
        throw new Error(
            `Expected one signed checkpoint transaction, got ${signedCheckpointTxs.length}`
        );
    }

    // combine the checkpoint signatures
    const serverSignedCheckpointTx = Transaction.fromPSBT(
        base64.decode(signedCheckpointTxs[0])
    );

    const finalCheckpointTx = combineTapscriptSigs(
        combinedSignedCheckpointTx,
        serverSignedCheckpointTx
    );

    // finalize the transaction
    await arkProvider.finalizeTx(arkTxid, [
        base64.encode(finalCheckpointTx.toPSBT()),
    ]);
};

/**
 * Validates the final Ark transaction.
 * checks that all inputs have a signature for the given pubkey
 * and the signature is correct for the given tapscript leaf
 * TODO: This is a simplified check, we should verify the actual signatures
 * @param finalArkTx The final Ark transaction in PSBT format.
 * @param _pubkey The public key of the user.
 * @param _tapLeaves The taproot script leaves.
 * @returns True if the final Ark transaction is valid, false otherwise.
 */
export const validFinalArkTx = (
    finalArkTx: string,
    _pubkey: Uint8Array,
    _tapLeaves: TapLeafScript[]
): boolean => {
    // decode the final Ark transaction
    const tx = Transaction.fromPSBT(base64.decode(finalArkTx), {
        allowUnknown: true,
    });
    if (!tx) return false;

    // push all inputs to an array
    const inputs: TransactionInput[] = [];
    for (let i = 0; i < tx.inputsLength; i++) {
        inputs.push(tx.getInput(i));
    }

    // basic check that all inputs have a witnessUtxo
    // this is a simplified check, we should verify the actual signatures
    return inputs.every((input) => input.witnessUtxo);
};
