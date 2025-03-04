import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { sha256x2 } from "@scure/btc-signer/utils";
import { aggregateKeys } from "../musig2";
import { getCosignerKeys, TreeNode, TxTree, TxTreeError } from "./vtxoTree";

export const ErrInvalidSettlementTx = new TxTreeError(
    "invalid settlement transaction"
);
export const ErrInvalidSettlementTxOutputs = new TxTreeError(
    "invalid settlement transaction outputs"
);
export const ErrEmptyTree = new TxTreeError("empty tree");
export const ErrInvalidRootLevel = new TxTreeError("invalid root level");
export const ErrNumberOfInputs = new TxTreeError("invalid number of inputs");
export const ErrWrongSettlementTxid = new TxTreeError("wrong settlement txid");
export const ErrInvalidAmount = new TxTreeError("invalid amount");
export const ErrNoLeaves = new TxTreeError("no leaves");
export const ErrNodeTxEmpty = new TxTreeError("node transaction empty");
export const ErrNodeTxidEmpty = new TxTreeError("node txid empty");
export const ErrNodeParentTxidEmpty = new TxTreeError("node parent txid empty");
export const ErrNodeTxidDifferent = new TxTreeError("node txid different");
export const ErrParentTxidInput = new TxTreeError("parent txid input mismatch");
export const ErrLeafChildren = new TxTreeError("leaf node has children");
export const ErrInvalidTaprootScript = new TxTreeError(
    "invalid taproot script"
);
export const ErrInternalKey = new TxTreeError("invalid internal key");
export const ErrInvalidControlBlock = new TxTreeError("invalid control block");
export const ErrInvalidRootTransaction = new TxTreeError(
    "invalid root transaction"
);
export const ErrInvalidNodeTransaction = new TxTreeError(
    "invalid node transaction"
);

const SHARED_OUTPUT_INDEX = 0;
const CONNECTORS_OUTPUT_INDEX = 1;

export function validateConnectorsTree(
    settlementTxB64: string,
    connectorsTree: TxTree
): void {
    connectorsTree.validate();

    const rootNode = connectorsTree.root();
    if (!rootNode) throw ErrEmptyTree;

    const rootTx = Transaction.fromPSBT(base64.decode(rootNode.tx));
    if (rootTx.inputsLength !== 1) throw ErrNumberOfInputs;

    const rootInput = rootTx.getInput(0);

    const settlementTx = Transaction.fromPSBT(base64.decode(settlementTxB64));
    if (settlementTx.outputsLength <= CONNECTORS_OUTPUT_INDEX)
        throw ErrInvalidSettlementTxOutputs;

    const expectedRootTxid = hex.encode(
        sha256x2(settlementTx.toBytes(true)).reverse()
    );

    if (!rootInput.txid) throw ErrWrongSettlementTxid;

    if (hex.encode(rootInput.txid) !== expectedRootTxid)
        throw ErrWrongSettlementTxid;

    if (rootInput.index !== CONNECTORS_OUTPUT_INDEX)
        throw ErrWrongSettlementTxid;
}

export function validateVtxoTree(
    settlementTx: string,
    vtxoTree: TxTree,
    sweepTapTreeRoot: Uint8Array
): void {
    vtxoTree.validate();

    // Parse settlement transaction
    let settlementTransaction: Transaction;
    try {
        settlementTransaction = Transaction.fromPSBT(
            base64.decode(settlementTx)
        );
    } catch {
        throw ErrInvalidSettlementTx;
    }

    if (settlementTransaction.outputsLength <= SHARED_OUTPUT_INDEX) {
        throw ErrInvalidSettlementTxOutputs;
    }

    const sharedOutput = settlementTransaction.getOutput(SHARED_OUTPUT_INDEX);
    if (!sharedOutput?.amount) throw ErrInvalidSettlementTxOutputs;
    const sharedOutputAmount = sharedOutput.amount;

    const nbNodes = vtxoTree.numberOfNodes();
    if (nbNodes === 0) {
        throw ErrEmptyTree;
    }

    if (vtxoTree.levels[0].length !== 1) {
        throw ErrInvalidRootLevel;
    }

    // Check root input is connected to settlement tx
    const rootNode = vtxoTree.levels[0][0];
    let rootTx: Transaction;
    try {
        rootTx = Transaction.fromPSBT(base64.decode(rootNode.tx));
    } catch {
        throw ErrInvalidRootTransaction;
    }

    if (rootTx.inputsLength !== 1) {
        throw ErrNumberOfInputs;
    }

    const rootInput = rootTx.getInput(0);
    if (!rootInput.txid || rootInput.index === undefined)
        throw ErrWrongSettlementTxid;

    const settlementTxid = hex.encode(
        sha256x2(settlementTransaction.toBytes(true)).reverse()
    );
    if (
        hex.encode(Buffer.from(rootInput.txid)) !== settlementTxid ||
        rootInput.index !== SHARED_OUTPUT_INDEX
    ) {
        throw ErrWrongSettlementTxid;
    }

    // Check root output amounts
    let sumRootValue = 0n;
    for (let i = 0; i < rootTx.outputsLength; i++) {
        const output = rootTx.getOutput(i);
        if (!output?.amount) continue;
        sumRootValue += output.amount;
    }

    if (sumRootValue >= sharedOutputAmount) {
        throw ErrInvalidAmount;
    }

    if (vtxoTree.leaves().length === 0) {
        throw ErrNoLeaves;
    }

    // Validate each node in the tree
    for (const level of vtxoTree.levels) {
        for (const node of level) {
            validateNode(vtxoTree, node, sweepTapTreeRoot);
        }
    }
}

function validateNode(
    vtxoTree: TxTree,
    node: TreeNode,
    tapTreeRoot: Uint8Array
): void {
    if (!node.tx) throw ErrNodeTxEmpty;
    if (!node.txid) throw ErrNodeTxidEmpty;
    if (!node.parentTxid) throw ErrNodeParentTxidEmpty;

    // Parse node transaction
    let tx: Transaction;
    try {
        tx = Transaction.fromPSBT(base64.decode(node.tx));
    } catch {
        throw ErrInvalidNodeTransaction;
    }

    const txid = hex.encode(sha256x2(tx.toBytes(true)).reverse());
    if (txid !== node.txid) {
        throw ErrNodeTxidDifferent;
    }

    if (tx.inputsLength !== 1) {
        throw ErrNumberOfInputs;
    }

    const input = tx.getInput(0);

    if (!input.txid) throw ErrParentTxidInput;
    if (hex.encode(input.txid) !== node.parentTxid) {
        throw ErrParentTxidInput;
    }

    const children = vtxoTree.children(node.txid);
    if (node.leaf && children.length >= 1) {
        throw ErrLeafChildren;
    }

    // Validate each child
    for (let childIndex = 0; childIndex < children.length; childIndex++) {
        const child = children[childIndex];
        const childTx = Transaction.fromPSBT(base64.decode(child.tx));

        const parentOutput = tx.getOutput(childIndex);
        if (!parentOutput?.script) throw ErrInvalidTaprootScript;

        const previousScriptKey = parentOutput.script.slice(2);
        if (previousScriptKey.length !== 32) {
            throw ErrInvalidTaprootScript;
        }

        // Get cosigner keys from input
        const cosignerKeys = getCosignerKeys(childTx);

        // Aggregate keys
        const { finalKey } = aggregateKeys(cosignerKeys, true, {
            taprootTweak: tapTreeRoot,
        });

        if (hex.encode(finalKey) !== hex.encode(previousScriptKey.slice(2))) {
            throw ErrInternalKey;
        }

        // Check amounts
        let sumChildAmount = 0n;
        for (let i = 0; i < childTx.outputsLength; i++) {
            const output = childTx.getOutput(i);
            if (!output?.amount) continue;
            sumChildAmount += output.amount;
        }

        if (!parentOutput.amount) throw ErrInvalidAmount;
        if (sumChildAmount >= parentOutput.amount) {
            throw ErrInvalidAmount;
        }
    }
}
