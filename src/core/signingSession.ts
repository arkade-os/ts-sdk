import * as musig2 from "../core/musig2";
import { VtxoTree } from "./vtxoTree.js";
import { SigHash, Transaction } from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { p2tr } from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";

// Error definitions
export const ErrMissingVtxoTree = new Error("missing vtxo tree");
export const ErrMissingAggregateKey = new Error("missing aggregate key");

export type TreeNonces = Pick<musig2.Nonces, "pubNonce">[][];
export type TreePartialSigs = musig2.PartialSig[][];

// Signer session defines the methods to participate in a cooperative signing process
// with participants of a settlement. It holds the state of the musig2 nonces and allows to
// create the partial signatures for each transaction in the vtxo tree
export interface SignerSession {
    getNonces(): TreeNonces;
    setKeys(keys: Uint8Array[]): void;
    setAggregatedNonces(nonces: TreeNonces): void;
    sign(): TreePartialSigs;
}

export class TreeSignerSession implements SignerSession {
    private myNonces: musig2.Nonces[][] | null = null;
    private keys: Uint8Array[] | null = null;
    private aggregateNonces: TreeNonces | null = null;

    constructor(
        private secretKey: Uint8Array,
        private tree: VtxoTree,
        private scriptRoot: Uint8Array,
        private rootSharedOutputAmount: bigint
    ) {}

    get publicKey(): Uint8Array {
        return secp256k1.getPublicKey(this.secretKey);
    }

    getNonces(): TreeNonces {
        if (!this.tree) throw ErrMissingVtxoTree;

        if (!this.myNonces) {
            this.myNonces = this.generateNonces();
        }

        const nonces: TreeNonces = [];

        for (const levelNonces of this.myNonces) {
            const levelPubNonces: Pick<musig2.Nonces, "pubNonce">[] = [];
            for (const nonce of levelNonces) {
                levelPubNonces.push({ pubNonce: nonce.pubNonce });
            }
            nonces.push(levelPubNonces);
        }

        return nonces;
    }

    setKeys(keys: Uint8Array[]) {
        if (this.keys) throw new Error("keys already set");
        this.keys = keys;
    }

    setAggregatedNonces(nonces: TreeNonces) {
        if (this.aggregateNonces) throw new Error("nonces already set");
        this.aggregateNonces = nonces;
    }

    sign(): TreePartialSigs {
        if (!this.tree) throw ErrMissingVtxoTree;
        if (!this.keys) throw ErrMissingAggregateKey;
        if (!this.aggregateNonces) throw new Error("nonces not set");
        if (!this.myNonces) throw new Error("nonces not generated");

        const sigs: TreePartialSigs = [];

        for (
            let levelIndex = 0;
            levelIndex < this.tree.levels.length;
            levelIndex++
        ) {
            const levelSigs: musig2.PartialSig[] = [];
            const level = this.tree.levels[levelIndex];

            for (let nodeIndex = 0; nodeIndex < level.length; nodeIndex++) {
                const node = level[nodeIndex];
                const tx = Transaction.fromPSBT(base64.decode(node.tx));
                const sig = this.signPartial(tx, levelIndex, nodeIndex);
                levelSigs.push(sig);
            }

            sigs.push(levelSigs);
        }

        return sigs;
    }

    private generateNonces(): musig2.Nonces[][] {
        if (!this.tree) throw ErrMissingVtxoTree;

        const myNonces: musig2.Nonces[][] = [];

        const publicKey = secp256k1.getPublicKey(this.secretKey);

        for (const level of this.tree.levels) {
            const levelNonces: musig2.Nonces[] = [];
            for (let i = 0; i < level.length; i++) {
                const nonces = musig2.generateNonces(publicKey);
                levelNonces.push(nonces);
            }
            myNonces.push(levelNonces);
        }

        return myNonces;
    }

    private signPartial(
        tx: Transaction,
        levelIndex: number,
        nodeIndex: number
    ): musig2.PartialSig {
        if (!this.myNonces || !this.aggregateNonces || !this.keys) {
            throw new Error("session not properly initialized");
        }

        const myNonce = this.myNonces[levelIndex][nodeIndex];
        const aggNonce = this.aggregateNonces[levelIndex][nodeIndex];

        const prevoutAmounts: bigint[] = [];
        const prevoutScripts: Uint8Array[] = [];

        const { finalKey } = musig2.aggregateKeys(this.keys, true, {
            taprootTweak: this.scriptRoot,
        });

        for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
            const prevout = getPrevOutput(
                finalKey.slice(1),
                this.tree,
                this.rootSharedOutputAmount,
                tx
            );
            prevoutAmounts.push(prevout.amount);
            prevoutScripts.push(prevout.script);
        }

        // Get the message to sign (sighash)
        const message = tx.preimageWitnessV1(
            0, // always first input
            prevoutScripts,
            SigHash.DEFAULT,
            prevoutAmounts
        );

        // Create fixture data
        const fixtureData = {
            inputs: {
                secNonce: hex.encode(myNonce.secNonce),
                pubNonce: hex.encode(myNonce.pubNonce),
                secretKey: hex.encode(this.secretKey),
                aggNonce: hex.encode(aggNonce.pubNonce),
                publicKeys: this.keys.map((key) => hex.encode(key)),
                message: hex.encode(message),
                options: {
                    sortKeys: true,
                    taprootTweak: hex.encode(this.scriptRoot),
                },
            },
            result: "",
        };

        const partialSig = musig2.sign(
            myNonce.secNonce,
            myNonce.pubNonce,
            this.secretKey,
            aggNonce.pubNonce,
            this.keys,
            message,
            {
                taprootTweak: this.scriptRoot,
                sortKeys: true,
            }
        );

        fixtureData.result = hex.encode(partialSig.encode());
        console.log("Complete Fixture:", JSON.stringify(fixtureData, null, 2));

        return partialSig;
    }
}

// Helper function to validate tree signatures
export async function validateTreeSigs(
    finalAggregatedKey: Uint8Array,
    sharedOutputAmount: bigint,
    vtxoTree: VtxoTree
): Promise<void> {
    // Iterate through each level of the tree
    for (const level of vtxoTree.levels) {
        for (const node of level) {
            // Parse the transaction
            const tx = Transaction.fromPSBT(base64.decode(node.tx));
            const input = tx.getInput(0);

            // Check if input has signature
            if (!input.tapKeySig) {
                throw new Error("unsigned tree input");
            }

            // Get the previous output information
            const prevout = getPrevOutput(
                finalAggregatedKey,
                vtxoTree,
                sharedOutputAmount,
                tx
            );

            // Calculate the message that was signed
            const message = tx.preimageWitnessV1(
                0, // always first input
                [prevout.script],
                SigHash.DEFAULT,
                [prevout.amount]
            );

            // Verify the signature
            const isValid = schnorr.verify(
                input.tapKeySig,
                message,
                finalAggregatedKey
            );

            if (!isValid) {
                throw new Error("invalid signature");
            }
        }
    }
}

interface PrevOutput {
    script: Uint8Array;
    amount: bigint;
}

function getPrevOutput(
    finalAggregatedKey: Uint8Array,
    vtxoTree: VtxoTree,
    sharedOutputAmount: bigint,
    partial: Transaction
): PrevOutput {
    // Generate P2TR script
    const pkScript = p2tr(finalAggregatedKey).script;

    // Get root node
    const rootNode = vtxoTree.levels[0][0];
    if (!rootNode) throw new Error("empty vtxo tree");

    const input = partial.getInput(0);
    if (!input.txid) throw new Error("missing input txid");

    const parentTxID = hex.encode(input.txid);

    // Check if parent is root
    if (rootNode.parentTxid === parentTxID) {
        return {
            amount: sharedOutputAmount,
            script: pkScript,
        };
    }

    // Search for parent in tree
    let parent = null;
    for (const level of vtxoTree.levels) {
        for (const node of level) {
            if (node.txid === parentTxID) {
                parent = node;
                break;
            }
        }
        if (parent) break;
    }

    if (!parent) {
        throw new Error("parent tx not found");
    }

    // Parse parent tx
    const parentTx = Transaction.fromPSBT(base64.decode(parent.tx));

    if (!input.index) throw new Error("missing input index");
    const parentOutput = parentTx.getOutput(input.index);
    if (!parentOutput) throw new Error("parent output not found");
    if (!parentOutput.amount) throw new Error("parent output amount not found");

    return {
        amount: parentOutput.amount,
        script: pkScript,
    };
}
