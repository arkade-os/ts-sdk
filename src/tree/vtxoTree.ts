import * as bip68 from "bip68";
import { RawTx, ScriptNum, Transaction } from "@scure/btc-signer";
import { sha256x2 } from "@scure/btc-signer/utils";
import { base64, hex } from "@scure/base";
import { RelativeTimelock } from "../script/tapscript";

// Node represents a transaction and its parent txid in a vtxo tree
export interface TreeNode {
    txid: string;
    tx: string;
    parentTxid: string;
    leaf: boolean;
    level: number;
    levelIndex: number;
}

export class TxTreeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TxTreeError";
    }
}

export const ErrLeafNotFound = new TxTreeError("leaf not found in tx tree");
export const ErrParentNotFound = new TxTreeError("parent not found");

// TxTree is represented as a matrix of Node objects
// the first level of the matrix is the root of the tree
export class TxTree {
    private tree: (TreeNode | null)[][];

    static empty(): TxTree {
        return new TxTree([]);
    }

    constructor(tree: TreeNode[][]) {
        this.tree = tree;
    }

    get levels(): (TreeNode | null)[][] {
        return this.tree;
    }

    addNode(node: TreeNode): void {
        if (this.tree.length <= node.level) {
            // push empty levels until we reach the node's level
            for (let i = this.tree.length; i <= node.level; i++) {
                this.tree.push([]);
            }
        }

        if (this.tree[node.level].length <= node.levelIndex) {
            // push empty nodes until we reach the node's index
            for (
                let i = this.tree[node.level].length;
                i <= node.levelIndex;
                i++
            ) {
                this.tree[node.level].push(null);
            }
        }

        this.tree[node.level][node.levelIndex] = node;
    }

    addSignature(signature: string, level: number, levelIndex: number): void {
        if (this.tree.length <= level) {
            throw new TxTreeError(`level ${level} not found`);
        }

        if (this.tree[level].length <= levelIndex) {
            throw new TxTreeError(
                `level ${level} index ${levelIndex} not found`
            );
        }

        const tx = Transaction.fromPSBT(
            base64.decode(this.tree[level][levelIndex]!.tx)
        );
        tx.updateInput(0, {
            tapKeySig: hex.decode(signature),
        });
        this.tree[level][levelIndex]!.tx = base64.encode(tx.toPSBT());
    }

    // Returns the root node of the vtxo tree
    root(): TreeNode {
        if (this.tree.length <= 0 || this.tree[0].length <= 0) {
            throw new TxTreeError("empty vtxo tree");
        }

        const root = this.tree[0][0];
        if (!root) {
            throw new TxTreeError("empty root node");
        }

        return root;
    }

    // Returns the leaves of the vtxo tree
    leaves(): TreeNode[] {
        const leaves = [...this.tree[this.tree.length - 1]];

        // Check other levels for leaf nodes
        for (let i = 0; i < this.tree.length - 1; i++) {
            for (const node of this.tree[i]) {
                if (!node) continue;
                if (node && node.leaf) {
                    leaves.push(node);
                }
            }
        }

        return leaves.filter((node) => node !== null);
    }

    // Returns all nodes that have the given node as parent
    children(nodeTxid: string): TreeNode[] {
        const children: TreeNode[] = [];

        for (const level of this.tree) {
            for (const node of level) {
                if (!node) continue;
                if (node.parentTxid === nodeTxid) {
                    children.push(node);
                }
            }
        }

        return children;
    }

    // Returns the total number of nodes in the vtxo tree
    numberOfNodes(): number {
        return this.tree.reduce((count, level) => count + level.length, 0);
    }

    // Returns the branch of the given vtxo txid from root to leaf
    branch(vtxoTxid: string): TreeNode[] {
        const branch: TreeNode[] = [];
        const leaves = this.leaves();

        // Check if the vtxo is a leaf
        const leaf = leaves.find((leaf) => leaf.txid === vtxoTxid);
        if (!leaf) {
            throw ErrLeafNotFound;
        }

        branch.push(leaf);
        const rootTxid = this.root().txid;

        while (branch[0].txid !== rootTxid) {
            const parent = this.findParent(branch[0]);
            branch.unshift(parent);
        }

        return branch;
    }

    // Returns the remaining transactions to broadcast in order to exit the vtxo
    async exitBranch(
        vtxoTxid: string,
        isTxConfirmed: (txid: string) => Promise<boolean>
    ): Promise<string[]> {
        const offchainPart = await getOffchainPart(
            this.branch(vtxoTxid),
            isTxConfirmed
        );
        return offchainPart.map(getExitTransaction);
    }

    // Helper method to find parent of a node
    private findParent(node: TreeNode): TreeNode {
        for (const level of this.tree) {
            for (const potentialParent of level) {
                if (!potentialParent) continue;
                if (potentialParent.txid === node.parentTxid) {
                    return potentialParent;
                }
            }
        }
        throw ErrParentNotFound;
    }

    // Validates that the tree is coherent by checking txids and parent relationships
    validate(): void {
        // Skip the root level, validate from level 1 onwards
        for (let i = 1; i < this.tree.length; i++) {
            for (const node of this.tree[i]) {
                if (!node) throw new TxTreeError("null node");
                // Verify that the node's transaction matches its claimed txid
                const tx = Transaction.fromPSBT(base64.decode(node.tx));
                const txid = hex.encode(sha256x2(tx.toBytes(true)).reverse());
                if (txid !== node.txid) {
                    throw new TxTreeError(
                        `node ${node.txid} has txid ${node.txid}, but computed txid is ${txid}`
                    );
                }

                // Verify that the node has a valid parent
                try {
                    this.findParent(node);
                } catch (err) {
                    throw new TxTreeError(
                        `node ${node.txid} has no parent: ${err instanceof Error ? err.message : String(err)}`
                    );
                }
            }
        }
    }
}

async function getOffchainPart(
    branch: TreeNode[],
    isTxConfirmed: (txid: string) => Promise<boolean>
): Promise<TreeNode[]> {
    let offchainPath = [...branch];

    // Iterate from the end of the branch (leaf) to the beginning (root)
    for (let i = branch.length - 1; i >= 0; i--) {
        const node = branch[i];

        // check if the transaction is confirmed on-chain
        if (await isTxConfirmed(node.txid)) {
            // if this is the leaf node, return empty array as everything is confirmed
            if (i === branch.length - 1) {
                return [];
            }
            // otherwise, return the unconfirmed part of the branch
            return branch.slice(i + 1);
        }
    }

    // no confirmation: everything is offchain
    return offchainPath;
}

// getExitTransaction finalizes the psbt's input using the musig2 tapkey signature
function getExitTransaction(treeNode: TreeNode): string {
    const tx = Transaction.fromPSBT(base64.decode(treeNode.tx));
    const input = tx.getInput(0);
    if (!input.tapKeySig) throw new TxTreeError("missing tapkey signature");
    const rawTx = RawTx.decode(tx.unsignedTx);
    rawTx.witnesses = [[input.tapKeySig]];
    rawTx.segwitFlag = true;
    return hex.encode(RawTx.encode(rawTx));
}
