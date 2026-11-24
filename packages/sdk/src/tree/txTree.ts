import { DEFAULT_SEQUENCE } from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { hex } from "@scure/base";
import { Transaction } from "../utils/transaction";

/**
 * TxTreeNode is a node of the tree.
 * It contains the transaction id, the transaction and the children.
 * any TxTree can be serialized as a list of TxTreeNode.
 */
export type TxTreeNode = {
    txid: string;
    // base64 encoded root transaction
    tx: string;
    // map, output index -> child txid
    children: Record<number, string>;
};

type DecodedNode = {
    tx: Transaction;
    children: Record<number, string>;
};

/**
 * TxTree is a graph of bitcoin transactions.
 * It is used to represent batch tree created during settlement session
 */
export class TxTree {
    constructor(
        readonly root: Transaction,
        readonly children: Map<number, TxTree> = new Map(),
    ) {}

    static create(chunks: TxTreeNode[]): TxTree {
        if (chunks.length === 0) {
            throw new Error("empty chunks");
        }

        // Create a map to store all chunks by their txid for easy lookup
        const chunksByTxid = new Map<string, DecodedNode>();

        for (const chunk of chunks) {
            const decodedChunk = decodeNode(chunk);
            const txid = decodedChunk.tx.id;
            chunksByTxid.set(txid, decodedChunk);
        }

        // Find the root chunks (the ones that aren't referenced as a child)
        const childTxids = new Set(
            [...chunksByTxid.values()].flatMap((chunk) => Object.values(chunk.children)),
        );
        const rootTxids = [...chunksByTxid.keys()].filter((txid) => !childTxids.has(txid));

        if (rootTxids.length === 0) {
            throw new Error("no root chunk found");
        }

        if (rootTxids.length > 1) {
            throw new Error(`multiple root chunks found: ${rootTxids.join(", ")}`);
        }

        const graph = buildGraph(rootTxids[0], chunksByTxid);
        if (!graph) {
            throw new Error(`chunk not found for root txid: ${rootTxids[0]}`);
        }

        // verify that the number of chunks is equal to the number node in the graph
        if (graph.nbOfNodes() !== chunks.length) {
            throw new Error(
                `number of chunks (${chunks.length}) is not equal to the number of nodes in the graph (${graph.nbOfNodes()})`,
            );
        }

        return graph;
    }

    nbOfNodes(): number {
        let count = 1; // count this node
        for (const child of this.children.values()) {
            count += child.nbOfNodes();
        }
        return count;
    }

    validate(): void {
        if (!this.root) {
            throw new Error("unexpected nil root");
        }

        const nbOfOutputs = this.root.outputsLength;
        const nbOfInputs = this.root.inputsLength;

        if (nbOfInputs !== 1) {
            throw new Error(`unexpected number of inputs: ${nbOfInputs}, expected 1`);
        }

        // a node that is not final is not broadcastable at the moment the exit
        // path is needed, however well it is signed
        if (this.root.lockTime !== 0) {
            throw new Error(`unexpected locktime: ${this.root.lockTime}, expected 0`);
        }

        const sequence = this.root.getInput(0).sequence;
        if (sequence !== undefined && sequence !== DEFAULT_SEQUENCE) {
            throw new Error(`unexpected sequence: ${sequence}, expected ${DEFAULT_SEQUENCE}`);
        }

        // the children map can't be bigger than the number of outputs (excluding the P2A)
        // a graph can be "partial" and specify only some of the outputs as children,
        // that's why we allow len(g.Children) to be less than nbOfOutputs-1
        if (this.children.size > nbOfOutputs - 1) {
            throw new Error(
                `unexpected number of children: ${this.children.size}, expected maximum ${nbOfOutputs - 1}`,
            );
        }

        // validate each child
        for (const [outputIndex, child] of this.children) {
            if (outputIndex >= nbOfOutputs) {
                throw new Error(
                    `output index ${outputIndex} is out of bounds (nb of outputs: ${nbOfOutputs})`,
                );
            }

            child.validate();

            const childInput = child.root.getInput(0);
            const parentTxid = this.root.id;

            // verify the input of the child is the output of the parent
            if (
                !childInput.txid ||
                hex.encode(childInput.txid) !== parentTxid ||
                childInput.index !== outputIndex
            ) {
                throw new Error(`input of child ${outputIndex} is not the output of the parent`);
            }

            // verify the sum of the child's outputs is equal to the output of the parent
            let childOutputsSum = 0n;
            for (let i = 0; i < child.root.outputsLength; i++) {
                const output = child.root.getOutput(i);
                if (output?.amount) {
                    childOutputsSum += output.amount;
                }
            }

            const parentOutput = this.root.getOutput(outputIndex);
            if (!parentOutput?.amount) {
                throw new Error(`parent output ${outputIndex} has no amount`);
            }

            if (childOutputsSum !== parentOutput.amount) {
                throw new Error(
                    `sum of child's outputs is not equal to the output of the parent: ${childOutputsSum} != ${parentOutput.amount}`,
                );
            }
        }
    }

    leaves(): Transaction[] {
        if (this.children.size === 0) {
            return [this.root];
        }

        const leaves: Transaction[] = [];
        for (const child of this.children.values()) {
            leaves.push(...child.leaves());
        }
        return leaves;
    }

    get txid(): string {
        return this.root.id;
    }

    find(txid: string): TxTree | null {
        if (txid === this.txid) {
            return this;
        }

        for (const child of this.children.values()) {
            const found = child.find(txid);
            if (found) {
                return found;
            }
        }

        return null;
    }

    update(txid: string, fn: (tx: Transaction) => void): void {
        if (txid === this.txid) {
            fn(this.root);
            return;
        }

        for (const child of this.children.values()) {
            try {
                child.update(txid, fn);
                return;
            } catch (error) {
                // Continue searching in other children if not found
                continue;
            }
        }

        throw new Error(`tx not found: ${txid}`);
    }

    *iterator(): Generator<TxTree, void, unknown> {
        for (const child of this.children.values()) {
            yield* child.iterator();
        }
        yield this;
    }
}

// buildGraph recursively builds the TxGraph starting from the given txid
function buildGraph(
    rootTxid: string,
    chunksByTxid: Map<string, DecodedNode>,
    visited = new Set<string>(),
): TxTree | null {
    const chunk = chunksByTxid.get(rootTxid);
    if (!chunk) {
        return null;
    }
    // a shared or cyclic child is otherwise rebuilt once per edge, exponentially
    if (visited.has(rootTxid)) {
        throw new Error(`tx ${rootTxid} is referenced more than once in the tree`);
    }
    visited.add(rootTxid);

    const rootTx = chunk.tx;
    const children = new Map<number, TxTree>();

    // Recursively build children graphs
    for (const [outputIndexStr, childTxid] of Object.entries(chunk.children)) {
        const outputIndex = parseInt(outputIndexStr);
        const childGraph = buildGraph(childTxid, chunksByTxid, visited);
        if (childGraph) {
            children.set(outputIndex, childGraph);
        }
    }

    return new TxTree(rootTx, children);
}

function decodeNode(chunk: TxTreeNode): DecodedNode {
    const tx = Transaction.fromPSBT(base64.decode(chunk.tx));
    return { tx, children: chunk.children };
}
