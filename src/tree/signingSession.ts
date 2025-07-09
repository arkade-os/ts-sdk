import * as musig2 from "../musig2";
import { Script, SigHash, Transaction } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { randomPrivateKeyBytes, sha256x2 } from "@scure/btc-signer/utils";
import { CosignerPublicKey, getArkPsbtFields } from "../utils/unknownFields";
import { TxTree } from "./txTree";

export const ErrMissingVtxoGraph = new Error("missing vtxo graph");
export const ErrMissingAggregateKey = new Error("missing aggregate key");

export type TreeNonces = Map<string, Pick<musig2.Nonces, "pubNonce">>;
export type TreePartialSigs = Map<string, musig2.PartialSig>;

// Signer session defines the methods to participate in a cooperative signing process
// with participants of a settlement. It holds the state of the musig2 nonces and allows to
// create the partial signatures for each transaction in the vtxo tree
export interface SignerSession {
    getPublicKey(): Uint8Array;
    init(tree: TxTree, scriptRoot: Uint8Array, rootInputAmount: bigint): void;
    getNonces(): TreeNonces;
    setAggregatedNonces(nonces: TreeNonces): void;
    sign(): TreePartialSigs;
}

export class TreeSignerSession implements SignerSession {
    static NOT_INITIALIZED = new Error(
        "session not initialized, call init method"
    );

    private myNonces: Map<string, musig2.Nonces> | null = null;
    private aggregateNonces: TreeNonces | null = null;
    private graph: TxTree | null = null;
    private scriptRoot: Uint8Array | null = null;
    private rootSharedOutputAmount: bigint | null = null;

    constructor(private secretKey: Uint8Array) {}

    static random(): TreeSignerSession {
        const secretKey = randomPrivateKeyBytes();
        return new TreeSignerSession(secretKey);
    }

    init(tree: TxTree, scriptRoot: Uint8Array, rootInputAmount: bigint): void {
        this.graph = tree;
        this.scriptRoot = scriptRoot;
        this.rootSharedOutputAmount = rootInputAmount;
    }

    getPublicKey(): Uint8Array {
        return secp256k1.getPublicKey(this.secretKey);
    }

    getNonces(): TreeNonces {
        if (!this.graph) throw ErrMissingVtxoGraph;
        if (!this.myNonces) {
            this.myNonces = this.generateNonces();
        }

        const publicNonces: TreeNonces = new Map();

        for (const [txid, nonces] of this.myNonces) {
            publicNonces.set(txid, { pubNonce: nonces.pubNonce });
        }

        return publicNonces;
    }

    setAggregatedNonces(nonces: TreeNonces) {
        if (this.aggregateNonces) throw new Error("nonces already set");
        this.aggregateNonces = nonces;
    }

    sign(): TreePartialSigs {
        if (!this.graph) throw ErrMissingVtxoGraph;
        if (!this.aggregateNonces) throw new Error("nonces not set");
        if (!this.myNonces) throw new Error("nonces not generated");

        const sigs: TreePartialSigs = new Map();

        for (const g of this.graph) {
            const sig = this.signPartial(g);
            sigs.set(g.txid, sig);
        }

        return sigs;
    }

    private generateNonces(): Map<string, musig2.Nonces> {
        if (!this.graph) throw ErrMissingVtxoGraph;

        const myNonces: Map<string, musig2.Nonces> = new Map();

        const publicKey = secp256k1.getPublicKey(this.secretKey);

        for (const g of this.graph) {
            const nonces = musig2.generateNonces(publicKey);
            myNonces.set(g.txid, nonces);
        }

        return myNonces;
    }

    private signPartial(g: TxTree): musig2.PartialSig {
        if (!this.graph || !this.scriptRoot || !this.rootSharedOutputAmount) {
            throw TreeSignerSession.NOT_INITIALIZED;
        }

        if (!this.myNonces || !this.aggregateNonces) {
            throw new Error("session not properly initialized");
        }

        const myNonce = this.myNonces.get(g.txid);
        if (!myNonce) throw new Error("missing private nonce");

        const aggNonce = this.aggregateNonces.get(g.txid);
        if (!aggNonce) throw new Error("missing aggregate nonce");
        const prevoutAmounts: bigint[] = [];
        const prevoutScripts: Uint8Array[] = [];

        const cosigners = getArkPsbtFields(g.root, 0, CosignerPublicKey).map(
            (c) => c.key
        );

        const { finalKey } = musig2.aggregateKeys(cosigners, true, {
            taprootTweak: this.scriptRoot,
        });

        for (
            let inputIndex = 0;
            inputIndex < g.root.inputsLength;
            inputIndex++
        ) {
            const prevout = getPrevOutput(
                finalKey,
                this.graph,
                this.rootSharedOutputAmount,
                g.root
            );
            prevoutAmounts.push(prevout.amount);
            prevoutScripts.push(prevout.script);
        }

        const message = g.root.preimageWitnessV1(
            0, // always first input
            prevoutScripts,
            SigHash.DEFAULT,
            prevoutAmounts
        );

        return musig2.sign(
            myNonce.secNonce,
            this.secretKey,
            aggNonce.pubNonce,
            cosigners,
            message,
            {
                taprootTweak: this.scriptRoot,
                sortKeys: true,
            }
        );
    }
}

// Helper function to validate tree signatures
export async function validateTreeSigs(
    finalAggregatedKey: Uint8Array,
    sharedOutputAmount: bigint,
    vtxoTree: TxTree
): Promise<void> {
    // Iterate through each level of the tree
    for (const g of vtxoTree) {
        // Parse the transaction
        const input = g.root.getInput(0);

        // Check if input has signature
        if (!input.tapKeySig) {
            throw new Error("unsigned tree input");
        }

        // Get the previous output information
        const prevout = getPrevOutput(
            finalAggregatedKey,
            vtxoTree,
            sharedOutputAmount,
            g.root
        );

        // Calculate the message that was signed
        const message = g.root.preimageWitnessV1(
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

interface PrevOutput {
    script: Uint8Array;
    amount: bigint;
}

function getPrevOutput(
    finalKey: Uint8Array,
    graph: TxTree,
    sharedOutputAmount: bigint,
    tx: Transaction
): PrevOutput {
    // generate P2TR script from musig2 final key
    const pkScript = Script.encode(["OP_1", finalKey.slice(1)]);

    const txid = hex.encode(sha256x2(tx.toBytes(true)).reverse());

    // if the input is the root input, return the shared output amount
    if (txid === graph.txid) {
        return {
            amount: sharedOutputAmount,
            script: pkScript,
        };
    }

    // find the parent transaction
    const parentInput = tx.getInput(0);
    if (!parentInput.txid) throw new Error("missing parent input txid");
    const parentTxid = hex.encode(new Uint8Array(parentInput.txid));
    const parent = graph.find(parentTxid);
    if (!parent) throw new Error("parent  tx not found");

    if (parentInput.index === undefined) throw new Error("missing input index");
    const parentOutput = parent.root.getOutput(parentInput.index);
    if (!parentOutput) throw new Error("parent output not found");
    if (!parentOutput.amount) throw new Error("parent output amount not found");

    return {
        amount: parentOutput.amount,
        script: pkScript,
    };
}
