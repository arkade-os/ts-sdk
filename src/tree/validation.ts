import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { base64 } from "@scure/base";
import { aggregateKeys } from "../musig2";
import { TxTree } from "./txTree";
import { CosignerPublicKey, getArkPsbtFields } from "../utils/unknownFields";
import { ArkAddress } from "../script/address";
import { Packet } from "../asset";
import { equalBytes } from "@scure/btc-signer/utils.js";

export const ErrInvalidSettlementTx = (tx: string) =>
    new Error(`invalid settlement transaction: ${tx}`);
export const ErrInvalidSettlementTxOutputs = new Error(
    "invalid settlement transaction outputs"
);
export const ErrEmptyTree = new Error("empty tree");
export const ErrNumberOfInputs = new Error("invalid number of inputs");
export const ErrWrongSettlementTxid = new Error("wrong settlement txid");
export const ErrInvalidAmount = new Error("invalid amount");
export const ErrNoLeaves = new Error("no leaves");
export const ErrInvalidTaprootScript = new Error("invalid taproot script");
export const ErrInvalidRoundTxOutputs = new Error(
    "invalid round transaction outputs"
);
export const ErrWrongCommitmentTxid = new Error("wrong commitment txid");
export const ErrMissingCosignersPublicKeys = new Error(
    "missing cosigners public keys"
);
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

/**
 * Receiver represents an expected output in the vtxo tree.
 * Used for validation to ensure the server included all requested outputs.
 */
export interface Receiver {
    address: string;
    amount: bigint;
    assets?: { assetId: string; amount: bigint }[];
}

const BATCH_OUTPUT_VTXO_INDEX = 0;
const BATCH_OUTPUT_CONNECTORS_INDEX = 1;

export function validateConnectorsTxGraph(
    settlementTxB64: string,
    connectorsGraph: TxTree
): void {
    connectorsGraph.validate();

    if (connectorsGraph.root.inputsLength !== 1) throw ErrNumberOfInputs;

    const rootInput = connectorsGraph.root.getInput(0);

    const settlementTx = Transaction.fromPSBT(base64.decode(settlementTxB64));
    if (settlementTx.outputsLength <= BATCH_OUTPUT_CONNECTORS_INDEX)
        throw ErrInvalidSettlementTxOutputs;

    const expectedRootTxid = settlementTx.id;

    if (!rootInput.txid) throw ErrWrongSettlementTxid;

    if (hex.encode(rootInput.txid) !== expectedRootTxid)
        throw ErrWrongSettlementTxid;

    if (rootInput.index !== BATCH_OUTPUT_CONNECTORS_INDEX)
        throw ErrWrongSettlementTxid;
}

// ValidateVtxoTxGraph checks if the given vtxo graph is valid.
// The function validates:
// - the number of nodes
// - the number of leaves
// - children coherence with parent.
// - every control block and taproot output scripts.
// - input and output amounts.
export function validateVtxoTxGraph(
    graph: TxTree,
    roundTransaction: Transaction,
    sweepTapTreeRoot: Uint8Array
): void {
    if (roundTransaction.outputsLength < BATCH_OUTPUT_VTXO_INDEX + 1) {
        throw ErrInvalidRoundTxOutputs;
    }

    const batchOutputAmount = roundTransaction.getOutput(
        BATCH_OUTPUT_VTXO_INDEX
    )?.amount;
    if (!batchOutputAmount) {
        throw ErrInvalidRoundTxOutputs;
    }

    if (!graph.root) {
        throw ErrEmptyTree;
    }

    const rootInput = graph.root.getInput(0);
    const commitmentTxid = roundTransaction.id;

    if (
        !rootInput.txid ||
        hex.encode(rootInput.txid) !== commitmentTxid ||
        rootInput.index !== BATCH_OUTPUT_VTXO_INDEX
    ) {
        throw ErrWrongCommitmentTxid;
    }

    let sumRootValue = 0n;
    for (let i = 0; i < graph.root.outputsLength; i++) {
        const output = graph.root.getOutput(i);
        if (output?.amount) {
            sumRootValue += output.amount;
        }
    }

    if (sumRootValue !== batchOutputAmount) {
        throw ErrInvalidAmount;
    }

    const leaves = graph.leaves();
    if (leaves.length === 0) {
        throw ErrNoLeaves;
    }

    // validate the graph structure
    graph.validate();

    // iterates over all the nodes of the graph to verify that cosigners public keys are corresponding to the parent output
    for (const g of graph.iterator()) {
        for (const [childIndex, child] of g.children) {
            const parentOutput = g.root.getOutput(childIndex);
            if (!parentOutput?.script) {
                throw new Error(`parent output ${childIndex} not found`);
            }

            const previousScriptKey = parentOutput.script.slice(2);
            if (previousScriptKey.length !== 32) {
                throw new Error(
                    `parent output ${childIndex} has invalid script`
                );
            }

            const cosigners = getArkPsbtFields(
                child.root,
                0,
                CosignerPublicKey
            );

            if (cosigners.length === 0) {
                throw ErrMissingCosignersPublicKeys;
            }

            const cosignerKeys = cosigners.map((c) => c.key);

            const { finalKey } = aggregateKeys(cosignerKeys, true, {
                taprootTweak: sweepTapTreeRoot,
            });

            if (
                !finalKey ||
                hex.encode(finalKey.slice(1)) !== hex.encode(previousScriptKey)
            ) {
                throw ErrInvalidTaprootScript;
            }
        }
    }
}

/**
 * Validates that all offchain receivers are present in the vtxo tree with correct amounts and assets.
 * This is critical for security - ensures the server included all requested outputs.
 *
 * @param vtxoTree - The vtxo tree to validate against
 * @param receivers - The expected receivers (only offchain addresses are validated)
 */
export function validateReceivers(
    vtxoTree: TxTree,
    receivers: Receiver[]
): void {
    for (const receiver of receivers) {
        // Try to decode as ark address - skip onchain addresses
        let arkAddress: ArkAddress;
        try {
            arkAddress = ArkAddress.decode(receiver.address);
        } catch {
            // Not an ark address, skip (onchain addresses are validated elsewhere)
            continue;
        }

        validateOffchainReceiver(vtxoTree, arkAddress, receiver);
    }
}

/**
 * Validates that an offchain receiver is present in a vtxo tree leaf with correct amount and assets.
 */
function validateOffchainReceiver(
    vtxoTree: TxTree,
    arkAddress: ArkAddress,
    receiver: Receiver
): void {
    const vtxoTapKey = arkAddress.vtxoTaprootKey;
    const leaves = vtxoTree.leaves();

    let found = false;
    let foundOutputIndex = -1;
    let foundLeaf: Transaction | null = null;

    // Search through all leaves for matching output
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

            // Extract the x-only pubkey from the script (skip OP_1 prefix for P2TR)
            // P2TR script format: OP_1 (0x51) + 32-byte x-only pubkey
            const scriptKey = output.script.slice(2);
            if (scriptKey.length !== 32) {
                continue;
            }

            if (!equalBytes(scriptKey, vtxoTapKey)) {
                continue;
            }

            // Check amount matches
            if (output.amount !== receiver.amount) {
                continue;
            }

            found = true;
            foundOutputIndex = outputIndex;
            foundLeaf = leaf;

            // If receiver has assets, validate the asset packet
            if (receiver.assets && receiver.assets.length > 0) {
                validateAssetOutputs(leaf, outputIndex, receiver.assets);
            }
            break;
        }

        if (found) {
            break;
        }
    }

    if (!found) {
        throw ErrOffchainOutputNotFound(receiver.address);
    }
}

/**
 * Validates that the asset packet in a leaf transaction contains the expected assets
 * at the correct output index with correct amounts.
 */
function validateAssetOutputs(
    leafTx: Transaction,
    outputIndex: number,
    expectedAssets: { assetId: string; amount: bigint }[]
): void {
    // Find the OP_RETURN output containing the asset packet
    let assetPacket: Packet | null = null;

    for (let i = 0; i < leafTx.outputsLength; i++) {
        const output = leafTx.getOutput(i);
        if (!output?.script) {
            continue;
        }

        try {
            if (Packet.isAssetPacket(output.script)) {
                assetPacket = Packet.fromScript(output.script);
                break;
            }
        } catch {
            // Not an asset packet, continue
        }
    }

    if (!assetPacket) {
        throw ErrAssetGroupNotFound(expectedAssets[0].assetId);
    }

    // Validate each expected asset
    for (const expectedAsset of expectedAssets) {
        validateAssetGroupOutput(
            assetPacket,
            outputIndex,
            expectedAsset.assetId,
            expectedAsset.amount
        );
    }
}

/**
 * Validates that an asset group contains the expected output at the correct index with correct amount.
 */
function validateAssetGroupOutput(
    packet: Packet,
    outputIndex: number,
    assetId: string,
    expectedAmount: bigint
): void {
    // Find the asset group for this asset ID
    const assetGroup = packet.groups.find((group) => {
        // Skip issuance groups (null assetId)
        if (group.assetId === null) {
            return false;
        }
        return group.assetId.toString() === assetId;
    });

    if (!assetGroup) {
        throw ErrAssetGroupNotFound(assetId);
    }

    // Find the output at the expected index
    const assetOutput = assetGroup.outputs.find(
        (output) => output.vout === outputIndex
    );

    if (!assetOutput) {
        throw ErrAssetOutputNotFound(assetId, outputIndex);
    }

    if (assetOutput.amount !== expectedAmount) {
        throw ErrInvalidAssetOutputAmount(
            assetOutput.amount,
            expectedAmount,
            assetId
        );
    }
}
