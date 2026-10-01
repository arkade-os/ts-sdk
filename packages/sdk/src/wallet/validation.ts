import { equalBytes } from "@scure/btc-signer/utils.js";
import type { Bytes } from "@scure/btc-signer/utils.js";
import { base64 } from "@scure/base";
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
export const ErrIntentOutputNotFound = (index: number, kind: "onchain" | "offchain") =>
    new ServerResponseMismatchError(
        `${kind} output ${index} of the intent proof is not present in what the server built`,
    );
export const ErrUnvalidatedIntentOutput = (index: number) =>
    new ServerResponseMismatchError(
        `offchain output ${index} of the intent proof cannot be validated: virtual output tree signing did not run`,
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

/** An output the user signed into the intent proof. */
export interface DeclaredOutput {
    index: number;
    script: Bytes;
    amount: bigint;
    onchain: boolean;
}

/**
 * The paying outputs a signed intent proof commits to. Zero-amount outputs are
 * the proof's own placeholder and any extension packet, neither of which pays.
 */
export function declaredIntentOutputs(
    signedProof: string,
    onchainOutputIndexes: number[],
): DeclaredOutput[] {
    const proof = Transaction.fromPSBT(base64.decode(signedProof));
    const onchain = new Set(onchainOutputIndexes);
    const declared: DeclaredOutput[] = [];
    for (let i = 0; i < proof.outputsLength; i++) {
        const output = proof.getOutput(i);
        if (!output?.script || output.script.length === 0 || !output.amount) continue;
        declared.push({
            index: i,
            script: output.script,
            amount: output.amount,
            onchain: onchain.has(i),
        });
    }
    return declared;
}

/**
 * {@link validateBatchRecipients} against the outputs the user already signed
 * into the intent proof. Assets are not covered: a packet carries no amount, so
 * an intent whose asset assignment matters wants the explicit list.
 */
export function validateBatchAgainstIntent(
    commitmentTx: Transaction,
    vtxoTreeLeaves: Transaction[],
    declared: DeclaredOutput[],
): void {
    const usedOnchain = new Set<number>();
    const usedLeaf = new Set<string>();
    for (const output of declared) {
        if (output.onchain) {
            if (!takeOnchainOutput(commitmentTx, output, usedOnchain)) {
                throw ErrIntentOutputNotFound(output.index, "onchain");
            }
            continue;
        }
        if (!takeLeafOutput(vtxoTreeLeaves, output, usedLeaf)) {
            throw ErrIntentOutputNotFound(output.index, "offchain");
        }
    }
}

/** {@link validateBatchAgainstIntent} for a batch whose tree was never
 * validated; offchain outputs are refused rather than checked, as in
 * {@link validateBatchRecipientsWithoutTree}. */
export function validateBatchAgainstIntentWithoutTree(
    commitmentTx: Transaction,
    declared: DeclaredOutput[],
): void {
    const usedOnchain = new Set<number>();
    for (const output of declared) {
        if (!output.onchain) {
            throw ErrUnvalidatedIntentOutput(output.index);
        }
        if (!takeOnchainOutput(commitmentTx, output, usedOnchain)) {
            throw ErrIntentOutputNotFound(output.index, "onchain");
        }
    }
}

function takeOnchainOutput(
    commitmentTx: Transaction,
    declared: DeclaredOutput,
    used: Set<number>,
): boolean {
    for (let i = 0; i < commitmentTx.outputsLength; i++) {
        if (used.has(i)) continue;
        const output = commitmentTx.getOutput(i);
        if (!output?.script || output.amount !== declared.amount) continue;
        if (!equalBytes(output.script, declared.script)) continue;
        used.add(i);
        return true;
    }
    return false;
}

function takeLeafOutput(
    leaves: Transaction[],
    declared: DeclaredOutput,
    used: Set<string>,
): boolean {
    for (let leafIdx = 0; leafIdx < leaves.length; leafIdx++) {
        const leaf = leaves[leafIdx];
        for (let i = 0; i < leaf.outputsLength; i++) {
            const key = `${leafIdx}:${i}`;
            if (used.has(key)) continue;
            const output = leaf.getOutput(i);
            if (!output?.script || output.amount !== declared.amount) continue;
            if (!equalBytes(output.script, declared.script)) continue;
            used.add(key);
            return true;
        }
    }
    return false;
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
