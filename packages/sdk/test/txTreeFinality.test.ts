import { describe, it, expect } from "vitest";
import { DEFAULT_SEQUENCE } from "@scure/btc-signer";
import { Script } from "@scure/btc-signer/script.js";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { aggregateKeys } from "../src/musig2";
import { Transaction } from "../src/utils/transaction";
import { TxTree } from "../src/tree/txTree";
import {
    validateVtxoTxGraph,
    ErrInvalidRoundTxOutputs,
    ErrInvalidTaprootScript,
    ErrMissingCosignersPublicKeys,
} from "../src/tree/validation";
import { CosignerPublicKey, getArkPsbtFields, setArkPsbtField } from "../src/utils/unknownFields";

const P2TR = new Uint8Array([0x51, 0x20, ...new Uint8Array(32).fill(0xab)]);

// A tree node as the operator builds it: version 3, no locktime, final input.
function node(opts?: { lockTime?: number; sequence?: number }): Transaction {
    const tx = new Transaction({
        version: 3,
        lockTime: opts?.lockTime ?? 0,
        allowUnknownOutputs: true,
    });
    tx.addInput({
        txid: new Uint8Array(32).fill(1),
        index: 0,
        sequence: opts?.sequence,
        witnessUtxo: { script: P2TR, amount: 1000n },
    });
    tx.addOutput({ script: P2TR, amount: 1000n });
    return tx;
}

describe("TxTree finality", () => {
    it("accepts a final node", () => {
        expect(() => new TxTree(node()).validate()).not.toThrow();
    });

    it("accepts a node whose sequence is set explicitly to the final value", () => {
        expect(() => new TxTree(node({ sequence: DEFAULT_SEQUENCE })).validate()).not.toThrow();
    });

    it("rejects a node held back by an absolute locktime", () => {
        expect(() => new TxTree(node({ lockTime: 800_000 })).validate()).toThrow(
            /unexpected locktime: 800000, expected 0/,
        );
    });

    it("rejects a node held back by a relative timelock", () => {
        expect(() => new TxTree(node({ sequence: 1000 })).validate()).toThrow(
            /unexpected sequence: 1000/,
        );
    });

    it("rejects a non-final node buried in the tree, not just the root", () => {
        const parent = new Transaction({ version: 3, allowUnknownOutputs: true });
        parent.addInput({
            txid: new Uint8Array(32).fill(1),
            index: 0,
            witnessUtxo: { script: P2TR, amount: 1000n },
        });
        parent.addOutput({ script: P2TR, amount: 500n });
        parent.addOutput({ script: P2TR, amount: 500n });

        const child = new Transaction({
            version: 3,
            lockTime: 800_000,
            allowUnknownOutputs: true,
        });
        child.addInput({
            txid: hex.decode(parent.id),
            index: 0,
            witnessUtxo: { script: P2TR, amount: 500n },
        });
        child.addOutput({ script: P2TR, amount: 500n });

        const tree = new TxTree(parent, new Map([[0, new TxTree(child)]]));

        expect(() => tree.validate()).toThrow(/unexpected locktime: 800000/);
    });
    // TxTree.create parses nodes from base64 PSBTs, so the finality fields have
    // to survive that round trip, not just direct construction.
    it("keeps the finality fields across a PSBT round trip", () => {
        const encode = (tx: Transaction) => ({
            txid: tx.id,
            tx: base64.encode(tx.toPSBT()),
            children: {},
        });

        expect(() => TxTree.create([encode(node())]).validate()).not.toThrow();
        expect(() => TxTree.create([encode(node({ lockTime: 800_000 }))]).validate()).toThrow(
            /unexpected locktime: 800000/,
        );
        expect(() => TxTree.create([encode(node({ sequence: 1000 }))]).validate()).toThrow(
            /unexpected sequence: 1000/,
        );
    });

    // TxTree.create decodes with @scure/btc-signer's raw PSBT option defaults
    // ('unknown: strip') unless the decode path explicitly opts in to keeping
    // them. Arkade's cosigner pubkeys ride in a custom unknown field (key type
    // 222), so a decode that silently strips unknown fields would make every
    // cosigner lookup downstream (e.g. nonce aggregation) come up empty.
    it("keeps custom Arkade unknown fields (e.g. cosigner pubkeys) across a PSBT round trip", () => {
        const tx = node();
        const cosignerKey = new Uint8Array(33).fill(0x02);
        tx.updateInput(0, { unknown: [CosignerPublicKey.encode({ index: 0, key: cosignerKey })] });

        const decoded = TxTree.create([
            { txid: tx.id, tx: base64.encode(tx.toPSBT()), children: {} },
        ]);

        const cosigners = getArkPsbtFields(decoded.root, 0, CosignerPublicKey);
        expect(cosigners).toHaveLength(1);
        expect(hex.encode(cosigners[0]!.key)).toBe(hex.encode(cosignerKey));
    });

    it("rejects a transaction the tree reaches twice, before expanding it", () => {
        const chunk = (tx: Transaction, children: Record<number, string> = {}) => ({
            txid: tx.id,
            tx: base64.encode(tx.toPSBT()),
            children,
        });
        const [a, b] = [node({ lockTime: 1 }), node({ lockTime: 2 })];

        expect(() => TxTree.create([chunk(a, { 0: b.id, 1: b.id }), chunk(b)])).toThrow(
            /more than once/,
        );
        expect(() => TxTree.create([chunk(a, { 0: b.id }), chunk(b, { 0: b.id })])).toThrow(
            /more than once/,
        );
    });
});

describe("validateVtxoTxGraph output binding", () => {
    const sweepRoot = new Uint8Array(32).fill(7);
    const cosigners = [3, 4].map((n) => secp256k1.getPublicKey(new Uint8Array(32).fill(n), true));
    const treeKey = aggregateKeys(cosigners, true, { taprootTweak: sweepRoot }).finalKey.slice(1);
    const treeOutput = Script.encode(["OP_1", treeKey]);

    // The P2A anchor keeps a node with one child valid under TxTree.validate.
    function spend(
        txid: string,
        script: Uint8Array,
        signers: Uint8Array[] = cosigners,
    ): Transaction {
        const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
        tx.addInput({ txid: hex.decode(txid), index: 0 });
        signers.forEach((key, index) => setArkPsbtField(tx, 0, CosignerPublicKey, { index, key }));
        tx.addOutput({ script, amount: 1000n });
        tx.addOutput({ script: new Uint8Array([0x51, 0x02, 0x4e, 0x73]), amount: 0n });
        return tx;
    }

    function batch(opts: {
        batchOutput?: Uint8Array;
        edge?: Uint8Array;
        rootSigners?: Uint8Array[];
    }) {
        const commitment = new Transaction({ allowUnknownOutputs: true });
        commitment.addInput({ txid: new Uint8Array(32).fill(1), index: 0 });
        commitment.addOutput({ script: opts.batchOutput ?? treeOutput, amount: 1000n });
        const root = spend(commitment.id, opts.edge ?? P2TR, opts.rootSigners);
        const chunk = (tx: Transaction, children: Record<number, string> = {}) => ({
            txid: tx.id,
            tx: base64.encode(tx.toPSBT()),
            children,
        });
        const nodes = [chunk(root)];
        if (opts.edge) {
            const child = spend(root.id, P2TR);
            nodes[0] = chunk(root, { 0: child.id });
            nodes.push(chunk(child));
        }
        const tree = TxTree.create(nodes);
        return () => validateVtxoTxGraph(tree, commitment, sweepRoot);
    }

    it("binds the batch output to the root cosigners' key", () => {
        expect(batch({})).not.toThrow();
        expect(batch({ batchOutput: P2TR })).toThrow(ErrInvalidRoundTxOutputs);
    });

    it.each([
        ["v0", 0x00],
        ["v2", 0x52],
    ])("rejects an internal output carrying the key under a witness %s program", (_version, op) => {
        expect(batch({ edge: new Uint8Array([op, 0x20, ...treeKey]) })).toThrow(
            ErrInvalidTaprootScript,
        );
    });

    it("rejects a root that names no cosigners", () => {
        expect(batch({ rootSigners: [] })).toThrow(ErrMissingCosignersPublicKeys);
    });
});
