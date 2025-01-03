import * as musig2 from "@cmdcode/musig2";
import { VtxoTree } from "./vtxoTree.js";
import { SigHash, Transaction } from "@scure/btc-signer";
import { combineNonces, getNonceCtx } from "./musig2.js";
import { Bytes } from "@cmdcode/buff";
import { base64, hex } from "@scure/base";
import { p2tr } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";

// Error definitions
export const ErrMissingVtxoTree = new Error("missing vtxo tree");
export const ErrMissingAggregateKey = new Error("missing aggregate key");

export interface Musig2Nonces {
    pubNonce: Uint8Array;
    secNonce: Uint8Array;
}

// Type definitions for tree public nonces and partial signatures
export type TreeNonces = Pick<Musig2Nonces, "pubNonce">[][];
export type TreePartialSigs = Bytes[][];

// Interface for signer session
export interface SignerSession {
    getNonces(): TreeNonces;
    setKeys(keys: Uint8Array[]): void;
    setAggregatedNonces(nonces: TreeNonces): void;
    sign(): TreePartialSigs;
}

// Interface for coordinator session
export interface CoordinatorSession {
    addNonce(pubkey: Uint8Array, nonces: TreeNonces): void;
    aggregateNonces(): TreeNonces;
    addSig(pubkey: Uint8Array, sigs: TreePartialSigs): void;
    signTree(): VtxoTree;
}

export class TreeCoordinatorSession implements CoordinatorSession {
    private nonces: Map<string, TreeNonces> = new Map();
    private sigs: Map<string, TreePartialSigs> = new Map();
    private aggregatedNonces: TreeNonces | null = null;

    constructor(
        private tree: VtxoTree,
        private pubkeys: Uint8Array[],
        private scriptRoot: Uint8Array
    ) {}

    addNonce(pubkey: Uint8Array, nonces: TreeNonces): void {
        // Validate nonce structure matches tree
        if (nonces.length !== this.tree.levels.length) {
            throw new Error("nonce levels do not match tree levels");
        }

        for (let i = 0; i < nonces.length; i++) {
            if (nonces[i].length !== this.tree.levels[i].length) {
                throw new Error(`nonce count mismatch at level ${i}`);
            }
        }

        const pubkeyHex = hex.encode(pubkey);
        this.nonces.set(pubkeyHex, nonces);
    }

    aggregateNonces(): TreeNonces {
        if (this.aggregatedNonces) return this.aggregatedNonces;

        // Ensure we have nonces from all participants
        for (const pubkey of this.pubkeys) {
            const pubkeyHex = hex.encode(pubkey);
            if (!this.nonces.has(pubkeyHex)) {
                throw new Error(`missing nonces for pubkey ${pubkeyHex}`);
            }
        }

        const aggregatedNonces: TreeNonces = [];

        // For each level in the tree
        for (
            let levelIndex = 0;
            levelIndex < this.tree.levels.length;
            levelIndex++
        ) {
            const levelNonces: Pick<Musig2Nonces, "pubNonce">[] = [];

            // For each node in the level
            for (
                let nodeIndex = 0;
                nodeIndex < this.tree.levels[levelIndex].length;
                nodeIndex++
            ) {
                // Collect nonces from all participants for this node
                const nodeNonces: Uint8Array[] = [];
                for (const pubkey of this.pubkeys) {
                    const participantNonces = this.nonces.get(
                        hex.encode(pubkey)
                    )!;
                    nodeNonces.push(
                        participantNonces[levelIndex][nodeIndex].pubNonce
                    );
                }

                // Aggregate nonces for this node
                const aggregatedNodeNonce = combineNonces(nodeNonces);
                levelNonces.push({ pubNonce: aggregatedNodeNonce });
            }

            aggregatedNonces.push(levelNonces);
        }

        this.aggregatedNonces = aggregatedNonces;
        return aggregatedNonces;
    }

    addSig(pubkey: Uint8Array, sigs: TreePartialSigs): void {
        // Validate signature structure matches tree
        if (sigs.length !== this.tree.levels.length) {
            throw new Error("signature levels do not match tree levels");
        }

        for (let i = 0; i < sigs.length; i++) {
            if (sigs[i].length !== this.tree.levels[i].length) {
                throw new Error(`signature count mismatch at level ${i}`);
            }
        }

        const pubkeyHex = hex.encode(pubkey);
        this.sigs.set(pubkeyHex, sigs);
    }

    signTree(): VtxoTree {
        // Ensure we have signatures from all participants
        for (const pubkey of this.pubkeys) {
            const pubkeyHex = hex.encode(pubkey);
            if (!this.sigs.has(pubkeyHex)) {
                throw new Error(`missing signatures for pubkey ${pubkeyHex}`);
            }
        }

        if (!this.aggregatedNonces) {
            throw new Error("nonces not aggregated");
        }

        const keyCtx = musig2.get_key_ctx(this.pubkeys);
        const tweakedKeyCtx = musig2.tweak_key_ctx(keyCtx, [this.scriptRoot]);

        // For each level in the tree
        for (
            let levelIndex = 0;
            levelIndex < this.tree.levels.length;
            levelIndex++
        ) {
            // For each node in the level
            for (
                let nodeIndex = 0;
                nodeIndex < this.tree.levels[levelIndex].length;
                nodeIndex++
            ) {
                const node = this.tree.levels[levelIndex][nodeIndex];
                const tx = Transaction.fromPSBT(base64.decode(node.tx));

                // Collect partial signatures for this node
                const partialSigs: Bytes[] = [];
                for (const pubkey of this.pubkeys) {
                    const participantSigs = this.sigs.get(hex.encode(pubkey))!;
                    partialSigs.push(participantSigs[levelIndex][nodeIndex]);
                }

                // Get the message that was signed
                const prevout = getPrevOutput(
                    tweakedKeyCtx.group_pubkey,
                    this.tree,
                    0n, // Not needed for verification
                    tx
                );

                const message = tx.preimageWitnessV1(
                    0,
                    [prevout.script],
                    SigHash.DEFAULT,
                    [prevout.amount]
                );

                // Create signing context
                const ctx = musig2.create_ctx(
                    tweakedKeyCtx,
                    getNonceCtx(
                        this.aggregatedNonces[levelIndex][nodeIndex].pubNonce,
                        tweakedKeyCtx.group_pubkey,
                        message
                    ),
                    { key_tweaks: [this.scriptRoot] }
                );

                // Aggregate partial signatures
                const signature = musig2.combine_psigs(ctx, partialSigs);

                // Add signature to transaction
                tx.updateInput(0, { tapKeySig: signature });

                // Update node with signed transaction
                this.tree.levels[levelIndex][nodeIndex].tx = base64.encode(
                    tx.toPSBT()
                );
            }
        }

        return this.tree;
    }
}

export class TreeSignerSession implements SignerSession {
    private myNonces: Musig2Nonces[][] | null = null;
    private keys: Uint8Array[] | null = null;
    private aggregateNonces: TreeNonces | null = null;
    private keyCtx: musig2.KeyContext | null = null;

    constructor(
        private secretKey: Uint8Array,
        private tree: VtxoTree,
        private scriptRoot: Uint8Array,
        private rootSharedOutputAmount: bigint
    ) {}

    getNonces(): TreeNonces {
        if (!this.tree) throw ErrMissingVtxoTree;

        if (!this.myNonces) {
            this.myNonces = this.generateNonces();
        }

        const nonces: TreeNonces = [];

        for (const levelNonces of this.myNonces) {
            const levelPubNonces: Pick<Musig2Nonces, "pubNonce">[] = [];
            for (const nonce of levelNonces) {
                levelPubNonces.push({ pubNonce: nonce.pubNonce });
            }
            nonces.push(levelPubNonces);
        }

        return nonces;
    }

    setKeys(keys: Uint8Array[]) {
        if (this.keys) throw new Error("keys already set");

        const keyCtx = musig2.get_key_ctx(keys);
        const tweakedCtx = musig2.tweak_key_ctx(keyCtx, [this.scriptRoot]);
        this.keyCtx = tweakedCtx;
        this.keys = keys;

        // Verify our secret key is part of the key set
        const pubkey = musig2.keys.get_pubkey(this.secretKey);
        if (!keys.some((k) => Buffer.compare(k, pubkey) === 0)) {
            throw new Error("secret key not in key set");
        }
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
        if (!this.keyCtx) throw new Error("key context not set");

        const sigs: TreePartialSigs = [];

        for (
            let levelIndex = 0;
            levelIndex < this.tree.levels.length;
            levelIndex++
        ) {
            const levelSigs: Bytes[] = [];
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

    private generateNonces(): Musig2Nonces[][] {
        if (!this.tree) throw ErrMissingVtxoTree;

        const myNonces: Musig2Nonces[][] = [];

        for (const level of this.tree.levels) {
            const levelNonces: Musig2Nonces[] = [];
            for (let i = 0; i < level.length; i++) {
                const nonces = musig2.keys.gen_nonce_pair();
                levelNonces.push({ pubNonce: nonces[1], secNonce: nonces[0] });
            }
            myNonces.push(levelNonces);
        }

        return myNonces;
    }

    private signPartial(
        tx: Transaction,
        levelIndex: number,
        nodeIndex: number
    ): Bytes {
        if (!this.myNonces || !this.aggregateNonces || !this.keyCtx) {
            throw new Error("session not properly initialized");
        }

        const myNonce = this.myNonces[levelIndex][nodeIndex];
        const aggNonce = this.aggregateNonces[levelIndex][nodeIndex];

        const prevoutAmounts: bigint[] = [];
        const prevoutScripts: Uint8Array[] = [];

        for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
            const prevout = getPrevOutput(
                this.keyCtx.group_pubkey,
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

        const ctx = musig2.create_ctx(
            this.keyCtx,
            getNonceCtx(aggNonce.pubNonce, this.keyCtx.group_pubkey, message),
            { key_tweaks: [this.scriptRoot] }
        );
        return musig2.musign(ctx, this.secretKey, myNonce.secNonce);
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

// Helper function to aggregate public keys
export function aggregateKeys(
    pubkeys: Uint8Array[],
    scriptRoot: Uint8Array
): { aggregateKey: Uint8Array; finalKey: Uint8Array } {
    const keyCtx = musig2.get_key_ctx(pubkeys);
    const tweakKeyCtx = musig2.tweak_key_ctx(keyCtx, [scriptRoot]);

    return {
        aggregateKey: tweakKeyCtx.int_pubkey!,
        finalKey: tweakKeyCtx.group_pubkey,
    };
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
