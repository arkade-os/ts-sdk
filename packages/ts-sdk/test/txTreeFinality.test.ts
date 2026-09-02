import { describe, it, expect } from "vitest";
import { DEFAULT_SEQUENCE } from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { Transaction } from "../src/utils/transaction";
import { TxTree } from "../src/tree/txTree";

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
});
