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
    private tree: TreeNode[][];

    constructor(tree: TreeNode[][]) {
        this.tree = tree;
    }

    get levels(): TreeNode[][] {
        return this.tree;
    }

    // Returns the root node of the vtxo tree
    root(): TreeNode {
        if (this.tree.length <= 0 || this.tree[0].length <= 0) {
            throw new TxTreeError("empty vtxo tree");
        }
        return this.tree[0][0];
    }

    // Returns the leaves of the vtxo tree
    leaves(): TreeNode[] {
        const leaves = [...this.tree[this.tree.length - 1]];

        // Check other levels for leaf nodes
        for (let i = 0; i < this.tree.length - 1; i++) {
            for (const node of this.tree[i]) {
                if (node.leaf) {
                    leaves.push(node);
                }
            }
        }

        return leaves;
    }

    // Returns all nodes that have the given node as parent
    children(nodeTxid: string): TreeNode[] {
        const children: TreeNode[] = [];

        for (const level of this.tree) {
            for (const node of level) {
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

const COSIGNER_KEY_PREFIX = new Uint8Array(
    "cosigner".split("").map((c) => c.charCodeAt(0))
);

const VTXO_TREE_EXPIRY_PSBT_KEY = new Uint8Array(
    "expiry".split("").map((c) => c.charCodeAt(0))
);

export function getVtxoTreeExpiry(input: {
    unknown?: { key: Uint8Array; value: Uint8Array }[];
}): RelativeTimelock | null {
    if (!input.unknown) return null;

    for (const u of input.unknown) {
        // Check if key contains the VTXO tree expiry key
        if (u.key.length < VTXO_TREE_EXPIRY_PSBT_KEY.length) continue;

        let found = true;
        for (let i = 0; i < VTXO_TREE_EXPIRY_PSBT_KEY.length; i++) {
            if (u.key[i] !== VTXO_TREE_EXPIRY_PSBT_KEY[i]) {
                found = false;
                break;
            }
        }

        if (found) {
            const value = ScriptNum(6, true).decode(u.value);
            const { blocks, seconds } = bip68.decode(Number(value));
            return {
                type: blocks ? "blocks" : "seconds",
                value: BigInt(blocks ?? seconds ?? 0),
            };
        }
    }

    return null;
}

function parsePrefixedCosignerKey(key: Uint8Array): boolean {
    if (key.length < COSIGNER_KEY_PREFIX.length) return false;

    for (let i = 0; i < COSIGNER_KEY_PREFIX.length; i++) {
        if (key[i] !== COSIGNER_KEY_PREFIX[i]) return false;
    }
    return true;
}

export function getCosignerKeys(tx: Transaction): Uint8Array[] {
    const keys: Uint8Array[] = [];

    const input = tx.getInput(0);

    if (!input.unknown) return keys;

    for (const unknown of input.unknown) {
        const ok = parsePrefixedCosignerKey(
            new Uint8Array([unknown[0].type, ...unknown[0].key])
        );

        if (!ok) continue;

        // Assuming the value is already a valid public key in compressed format
        keys.push(unknown[1]);
    }

    return keys;
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
