import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { sha256x2 } from "@scure/btc-signer/utils";
import { aggregateKeys } from "../musig2";
import { TxTree } from "./txTree";
import { CosignerPublicKey, getArkPsbtFields } from "../utils/unknownFields";

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

    const expectedRootTxid = hex.encode(
        sha256x2(settlementTx.toBytes(true)).reverse()
    );

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
    const commitmentTxid = hex.encode(
        sha256x2(roundTransaction.toBytes(true)).reverse()
    );

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
    for (const g of graph) {
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
