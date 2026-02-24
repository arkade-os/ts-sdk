import { equalBytes } from "@scure/btc-signer/utils.js";
import { Recipient, Asset } from ".";
import { ArkAddress } from "../script/address";
import { Transaction } from "../utils/transaction";
import { Packet } from "../asset";
import { Address, OutScript } from "@scure/btc-signer";

export const ErrOffchainOutputNotFound = (address: string) =>
    new Error(`offchain send output not found: ${address}`);
export const ErrInvalidAssetOutputAmount = (
    got: bigint,
    want: bigint,
    assetId: string
) =>
    new Error(
        `invalid asset output amount for ${assetId}: got ${got}, want ${want}`
    );
export const ErrAssetGroupNotFound = (assetId: string) =>
    new Error(`asset group not found in batch leaf: ${assetId}`);
export const ErrAssetOutputNotFound = (assetId: string, outputIndex: number) =>
    new Error(
        `asset output not found in asset group ${assetId} at index ${outputIndex}`
    );
export const ErrInvalidOnchainOutputAmount = (address: string) =>
    new Error(`invalid onchain output amount: ${address}`);
export const ErrInvalidOnchainOutputAssets = (address: string) =>
    new Error(`onchain output ${address} cannot have assets`);
export const ErrOnchainOutputNotFound = (address: string) =>
    new Error(`onchain output not found: ${address}`);
export const ErrInvalidOffchainOutputAmount = (address: string) =>
    new Error(`invalid offchain output ${address}, missing amount`);

/**
 * Validates that all recipients are present in the vtxo tree leaves with correct amounts and assets (offchain recipient)
 * And validate the onchain recipients are in the round transaction outputs with correct amounts and script.
 *
 * @param commitmentTx - The commitment transaction to validate against
 * @param vtxoTreeLeaves - The vtxo tree leaves to validate against
 * @param recipients - The expected recipients (only offchain addresses are validated)
 */
export function validateBatchRecipients(
    commitmentTx: Transaction,
    vtxoTreeLeaves: Transaction[],
    recipients: Recipient[]
): void {
    for (const recipient of recipients) {
        let arkAddress: ArkAddress;
        try {
            arkAddress = ArkAddress.decode(recipient.address);
        } catch {
            validateOnchainRecipient(commitmentTx, recipient);
            continue;
        }

        validateOffchainRecipient(vtxoTreeLeaves, arkAddress, recipient);
    }
}

// validateOnchainRecipients verifies the given recipient is present in the commitment tx outputs list
function validateOnchainRecipient(
    commitmentTx: Transaction,
    recipient: Recipient
): void {
    const addr = Address().decode(recipient.address);
    const expectedPkScript = OutScript.encode(addr);

    if (!recipient.amount) {
        throw ErrInvalidOnchainOutputAmount(recipient.address);
    }
    if (recipient.assets && recipient.assets.length > 0) {
        throw ErrInvalidOnchainOutputAssets(recipient.address);
    }

    for (let i = 0; i < commitmentTx.outputsLength; i++) {
        const output = commitmentTx.getOutput(i);
        if (!output?.script || output.script.length === 0) {
            continue;
        }

        if (equalBytes(output.script, expectedPkScript)) {
            if (output.amount !== BigInt(recipient.amount)) {
                continue; // if amount does not match, continue
            }

            // we found the right output, recipient is valid, return
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
    recipient: Recipient
): void {
    const expectedPkScript = arkAddress.pkScript;
    if (!recipient.amount) {
        throw ErrInvalidOffchainOutputAmount(recipient.address);
    }
    const expectedAmount = BigInt(recipient.amount);

    let found = false;

    for (const leaf of leaves) {
        for (
            let outputIndex = 0;
            outputIndex < leaf.outputsLength;
            outputIndex++
        ) {
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
    expectedAssets: Asset[]
): void {
    const assetPacket = Packet.fromTx(leafTx);

    for (const { assetId, amount } of expectedAssets) {
        validateAssetGroupOutput(assetPacket, outputIndex, assetId, amount);
    }
}

function validateAssetGroupOutput(
    packet: Packet,
    outputIndex: number,
    assetId: string,
    expectedAmount: number
): void {
    const assetGroup = packet.groups.find((group) => {
        if (group.isIssuance()) return false;
        return group.assetId!.toString() === assetId;
    });

    if (!assetGroup) {
        throw ErrAssetGroupNotFound(assetId);
    }

    // find the output at the expected index
    const assetOutput = assetGroup.outputs.find(
        (output) => output.vout === outputIndex
    );

    if (!assetOutput) {
        throw ErrAssetOutputNotFound(assetId, outputIndex);
    }

    const expectedAmountBigInt = BigInt(expectedAmount);
    if (assetOutput.amount !== expectedAmountBigInt) {
        throw ErrInvalidAssetOutputAmount(
            assetOutput.amount,
            expectedAmountBigInt,
            assetId
        );
    }
}
