import { equalBytes } from "@scure/btc-signer/utils.js";
import { Recipient, Asset } from ".";
import { ArkAddress } from "../script/address";
import { Transaction } from "../utils/transaction";
import { Packet } from "../extension/asset";
import { Extension } from "../extension";
import { Address, OutScript } from "@scure/btc-signer";
import type { Network } from "../networks";
import { ServerResponseMismatchError } from "../providers/errors";

// A requested recipient is absent from what the server built. Message text is
// stable and greppable: past the service-worker boundary `message` is the only
// field left to branch on, so it is the whole signal.
export const ErrOffchainOutputNotFound = (address: string) =>
    new ServerResponseMismatchError(`offchain send output not found: ${address}`);
export const ErrInvalidAssetOutputAmount = (got: bigint, want: bigint, assetId: string) =>
    new ServerResponseMismatchError(
        `invalid asset output amount for ${assetId}: got ${got}, want ${want}`,
    );
export const ErrAssetGroupNotFound = (assetId: string) =>
    new ServerResponseMismatchError(`asset group not found in batch leaf: ${assetId}`);
export const ErrAssetOutputNotFound = (assetId: string, outputIndex: number) =>
    new ServerResponseMismatchError(
        `asset output not found in asset group ${assetId} at index ${outputIndex}`,
    );
export const ErrOnchainOutputNotFound = (address: string) =>
    new ServerResponseMismatchError(`onchain output not found: ${address}`);
export const ErrUnvalidatedOffchainOutput = (address: string) =>
    new ServerResponseMismatchError(
        `offchain output ${address} cannot be validated: virtual output tree signing did not run`,
    );

// Malformed recipient list from the caller, not a server response: plain
// `Error`, since there is nothing for a consumer to branch on.
export const ErrInvalidOnchainOutputAmount = (address: string) =>
    new Error(`invalid onchain output amount: ${address}`);
export const ErrInvalidOnchainOutputAssets = (address: string) =>
    new Error(`onchain output ${address} cannot have assets`);
export const ErrInvalidOffchainOutputAmount = (address: string) =>
    new Error(`invalid offchain output ${address}, missing amount`);

/**
 * Assert the commitment tx received at batch finalization is the one validated
 * at tree signing.
 *
 * The vtxo tree co-signed at tree signing spends `commitmentTxid:0`, so a
 * finalization commitment carrying another txid does not correspond to the tree
 * that was validated. The two are the same transaction by construction.
 *
 * No-op when `validatedCommitmentTxid` is undefined: tree signing was skipped
 * (not a cosigner, or an onchain-only settle), so there is nothing to compare
 * against.
 */
export function assertFinalCommitmentMatchesValidated(
    finalCommitmentTx: Transaction,
    validatedCommitmentTxid: string | undefined,
    context: string,
): void {
    if (!validatedCommitmentTxid) return;
    if (finalCommitmentTx.id === validatedCommitmentTxid) return;
    throw new ServerResponseMismatchError(
        `${context}: finalization commitment tx ${finalCommitmentTx.id} differs from the validated commitment tx ${validatedCommitmentTxid}`,
    );
}

/**
 * Validates both offchain and onchain recipients.
 * Offchain recipients are checked against vtxo tree leaves for correct amounts and assets.
 * Onchain recipients are validated against the round transaction outputs (amounts and scripts)
 * via validateOnchainRecipient.
 *
 * Presence only: the commitment tx and the tree are shared with every other intent in the batch,
 * so outputs paying someone else are legitimate and cannot be rejected. What this asserts is that
 * a settlement cannot consume our inputs and pay us nothing.
 *
 * @param commitmentTx - The commitment transaction to validate against
 * @param vtxoTreeLeaves - The vtxo tree leaves to validate against
 * @param recipients - The expected recipients to validate (both offchain and onchain)
 * @param network - Network for decoding onchain addresses (e.g. mainnet, testnet)
 * @throws {Error} if a recipient is not present or invalid in the vtxo tree or commitment tx
 */
export function validateBatchRecipients(
    commitmentTx: Transaction,
    vtxoTreeLeaves: Transaction[],
    recipients: Recipient[],
    network: Network,
): void {
    // usedOutputs is used to track which outputs are validated to handle
    // duplicate recipients in the list
    const usedOutputs = new Set<string>();
    const usedOnchainOutputs = new Set<number>();
    for (const recipient of recipients) {
        let arkAddress: ArkAddress;
        try {
            arkAddress = ArkAddress.decode(recipient.address);
        } catch {
            validateOnchainRecipient(commitmentTx, recipient, network, usedOnchainOutputs);
            continue;
        }

        validateOffchainRecipient(vtxoTreeLeaves, arkAddress, recipient, usedOutputs);
    }
}

/**
 * Same guarantee as {@link validateBatchRecipients}, for a batch whose virtual
 * output tree was never validated — an onchain-only settle skips tree signing,
 * so the commitment tx received at finalization is the only artifact to check
 * against.
 *
 * Offchain recipients are rejected rather than checked: a leaf paying the right
 * script proves nothing until {@link validateVtxoTxGraph} has shown the tree is
 * rooted in the commitment tx, and that only runs during tree signing. A caller
 * reaching finalization with offchain recipients and no signing session has
 * asked for a settlement this function cannot vouch for.
 *
 * @throws if a recipient is absent from the commitment tx outputs, or is offchain
 */
export function validateBatchRecipientsWithoutTree(
    commitmentTx: Transaction,
    recipients: Recipient[],
    network: Network,
): void {
    const usedOnchainOutputs = new Set<number>();
    for (const recipient of recipients) {
        try {
            ArkAddress.decode(recipient.address);
        } catch {
            validateOnchainRecipient(commitmentTx, recipient, network, usedOnchainOutputs);
            continue;
        }

        throw ErrUnvalidatedOffchainOutput(recipient.address);
    }
}

// validateOnchainRecipient verifies the given recipient is present in the commitment tx outputs list
function validateOnchainRecipient(
    commitmentTx: Transaction,
    recipient: Recipient,
    network: Network,
    usedOutputs: Set<number>,
): void {
    const addr = Address(network).decode(recipient.address);
    const expectedPkScript = OutScript.encode(addr);

    if (!recipient.amount) {
        throw ErrInvalidOnchainOutputAmount(recipient.address);
    }
    if (recipient.assets && recipient.assets.length > 0) {
        throw ErrInvalidOnchainOutputAssets(recipient.address);
    }

    for (let i = 0; i < commitmentTx.outputsLength; i++) {
        if (usedOutputs.has(i)) {
            continue;
        }

        const output = commitmentTx.getOutput(i);
        if (!output?.script || output.script.length === 0) {
            continue;
        }

        if (equalBytes(output.script, expectedPkScript)) {
            if (output.amount !== BigInt(recipient.amount)) {
                continue; // if amount does not match, continue
            }

            // we found the right output, recipient is valid, return
            usedOutputs.add(i);
            return;
        }
    }

    // if we get here, the recipient is not present in the commitment tx outputs list
    throw ErrOnchainOutputNotFound(recipient.address);
}

// validate the offchain recipient is present in one of the leaf output
// also verify the asset packet is here, and point the same output index
function validateOffchainRecipient(
    leaves: Transaction[],
    arkAddress: ArkAddress,
    recipient: Recipient,
    usedOutputs: Set<string>, // leafIndex:outputIndex
): void {
    const expectedPkScript = arkAddress.pkScript;
    if (!recipient.amount) {
        throw ErrInvalidOffchainOutputAmount(recipient.address);
    }
    const expectedAmount = BigInt(recipient.amount);

    let found = false;

    for (let leafIdx = 0; leafIdx < leaves.length; leafIdx++) {
        const leaf = leaves[leafIdx];
        for (let outputIndex = 0; outputIndex < leaf.outputsLength; outputIndex++) {
            const output = leaf.getOutput(outputIndex);
            if (!output?.script || output.script.length === 0) {
                continue;
            }

            if (!equalBytes(output.script, expectedPkScript)) {
                continue;
            }

            if (output.amount !== expectedAmount) {
                continue;
            }

            const key = `${leafIdx}:${outputIndex}`;
            if (usedOutputs.has(key)) {
                continue;
            }

            usedOutputs.add(key);
            found = true;

            // if assets, validate the asset packet
            if (recipient.assets && recipient.assets.length > 0) {
                validateAssetOutputs(leaf, outputIndex, recipient.assets);
            }
            break;
        }

        if (found) {
            break;
        }
    }

    if (!found) {
        throw ErrOffchainOutputNotFound(recipient.address);
    }
}

function validateAssetOutputs(
    leafTx: Transaction,
    outputIndex: number,
    expectedAssets: Asset[],
): void {
    const ext = Extension.fromTx(leafTx);
    const assetPacket = ext.getAssetPacket();
    if (!assetPacket) {
        throw new Error("no asset packet found in extension");
    }

    for (const { assetId, amount } of expectedAssets) {
        validateAssetGroupOutput(assetPacket, outputIndex, assetId, amount);
    }
}

function validateAssetGroupOutput(
    packet: Packet,
    outputIndex: number,
    assetId: string,
    expectedAmount: bigint,
): void {
    const assetGroup = packet.groups.find((group) => {
        if (group.isIssuance()) return false;
        return group.assetId!.toString() === assetId;
    });

    if (!assetGroup) {
        throw ErrAssetGroupNotFound(assetId);
    }

    // find the output at the expected index
    const assetOutput = assetGroup.outputs.find((output) => output.vout === outputIndex);

    if (!assetOutput) {
        throw ErrAssetOutputNotFound(assetId, outputIndex);
    }

    if (assetOutput.amount !== expectedAmount) {
        throw ErrInvalidAssetOutputAmount(assetOutput.amount, expectedAmount, assetId);
    }
}
