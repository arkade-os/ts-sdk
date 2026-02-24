import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { base64 } from "@scure/base";
import { aggregateKeys } from "../musig2";
import { TxTree } from "./txTree";
import { CosignerPublicKey, getArkPsbtFields } from "../utils/unknownFields";
import { ArkAddress } from "../script/address";
import { Packet } from "../asset/packet";
import { Asset } from "../wallet";

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

export const ErrReceiverOutputNotFound = (address: string) =>
    new Error(`receiver output not found in vtxo tree: ${address}`);
export const ErrAssetGroupNotFound = (assetId: string) =>
    new Error(`asset group not found in batch leaf: ${assetId}`);
export const ErrAssetOutputNotFound = (assetId: string) =>
    new Error(`asset output not found in asset group: ${assetId}`);
export const ErrInvalidAssetAmount = (
    assetId: string,
    got: bigint,
    expected: bigint
) =>
    new Error(
        `invalid asset output amount for ${assetId}: got ${got}, want ${expected}`
    );

export interface VtxoTreeReceiver {
    address: string;
    amount: number;
    assets: Asset[];
}

/**
 * validateVtxoTreeOutputs validates that all receivers with assets have their
 * expected asset outputs present in the vtxo tree leaf transactions.
 *
 * For each receiver with assets:
 * 1. Find the leaf tx output matching the receiver's address and BTC amount
 * 2. Parse the asset packet from the leaf tx's OP_RETURN output
 * 3. Verify each expected asset is present with correct amount at correct output index
 */
export function validateVtxoTreeOutputs(
    tree: TxTree,
    receivers: VtxoTreeReceiver[]
): void {
    const leaves = tree.leaves();
    if (leaves.length === 0) {
        throw ErrNoLeaves;
    }

    for (const receiver of receivers) {
        // Skip receivers without assets
        if (!receiver.assets || receiver.assets.length === 0) {
            continue;
        }

        // Decode the receiver address to get the vtxo taproot key
        let rcvAddr: ArkAddress;
        try {
            rcvAddr = ArkAddress.decode(receiver.address);
        } catch {
            // Not an ark address, skip
            continue;
        }

        const vtxoTapKey = rcvAddr.vtxoTaprootKey;

        // Find the leaf tx output matching this receiver
        let found = false;
        for (const leafTx of leaves) {
            for (
                let outputIndex = 0;
                outputIndex < leafTx.outputsLength;
                outputIndex++
            ) {
                const output = leafTx.getOutput(outputIndex);
                if (!output?.script) continue;

                // Check if this is a P2TR output with matching taproot key
                // P2TR script format: OP_1 <32-byte taproot key>
                if (
                    output.script.length !== 34 ||
                    output.script[0] !== 0x51 || // OP_1
                    output.script[1] !== 0x20 // 32 bytes push
                ) {
                    continue;
                }

                const outputTapKey = output.script.slice(2);
                if (hex.encode(outputTapKey) !== hex.encode(vtxoTapKey)) {
                    continue;
                }

                // Check amount matches
                if (
                    !output.amount ||
                    output.amount !== BigInt(receiver.amount)
                ) {
                    continue;
                }

                // Found the matching output, validate asset packet
                found = true;
                validateAssetOutputs(leafTx, outputIndex, receiver);
                break;
            }
            if (found) break;
        }

        if (!found) {
            throw ErrReceiverOutputNotFound(receiver.address);
        }
    }
}

function validateAssetOutputs(
    leafTx: Transaction,
    outputIndex: number,
    receiver: VtxoTreeReceiver
): void {
    // Find the OP_RETURN output containing the asset packet
    let assetPacket: Packet | null = null;
    for (let i = 0; i < leafTx.outputsLength; i++) {
        const output = leafTx.getOutput(i);
        if (!output?.script) continue;

        if (Packet.isAssetPacket(output.script)) {
            assetPacket = Packet.fromTxOut(output.script);
            break;
        }
    }

    if (!assetPacket) {
        // No asset packet in leaf tx, but receiver expects assets
        throw ErrAssetGroupNotFound(receiver.assets[0].assetId);
    }

    // Validate each expected asset
    for (const expectedAsset of receiver.assets) {
        // Find the asset group with matching asset ID
        let foundGroup = false;
        for (const group of assetPacket.groups) {
            // Skip issuance groups (no asset ID)
            if (!group.assetId) continue;

            const groupAssetId = group.assetId.toString();
            if (groupAssetId === expectedAsset.assetId) {
                // Found the group, validate output exists with correct amount
                validateAssetGroupOutput(
                    group.outputs,
                    outputIndex,
                    expectedAsset
                );
                foundGroup = true;
                break;
            }
        }

        if (!foundGroup) {
            throw ErrAssetGroupNotFound(expectedAsset.assetId);
        }
    }
}

function validateAssetGroupOutput(
    outputs: { vout: number; amount: bigint }[],
    expectedOutputIndex: number,
    expectedAsset: Asset
): void {
    let found = false;
    for (const output of outputs) {
        if (output.vout !== expectedOutputIndex) continue;

        if (output.amount !== BigInt(expectedAsset.amount)) {
            throw ErrInvalidAssetAmount(
                expectedAsset.assetId,
                output.amount,
                BigInt(expectedAsset.amount)
            );
        }
        found = true;
        break;
    }

    if (!found) {
        throw ErrAssetOutputNotFound(expectedAsset.assetId);
    }
}
