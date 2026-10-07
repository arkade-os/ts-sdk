import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { Transaction as BtcSignerTransaction } from "@scure/btc-signer";
import { Transaction, VtxoScript } from "../src";
import { TapTreeCoder, toBIP371TapTree } from "../src/script/base";

/**
 * SDK releases before the scure 2.4 upgrade wrote `VtxoScript.encode()` bytes
 * (every leaf at depth 1) into `PSBT_OUT_TAP_TREE`. Indexers still serve those
 * transactions, and scure >= 2.4 rejects them on decode.
 */

const scriptWithLeaves = (n: number) =>
    new VtxoScript(Array.from({ length: n }, (_, i) => new Uint8Array([0x51 + i])));

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

/** scure >= 2.4 refuses to encode such a tree, so splice it into a valid PSBT. */
function psbtWithOutputTapTree(script: VtxoScript, tapTree: Uint8Array) {
    const tx = new Transaction();
    tx.addInput({ txid: new Uint8Array(32).fill(1), index: 0 });
    tx.addOutput({
        script: script.pkScript,
        amount: 1000n,
        tapTree: toBIP371TapTree(script.encode()),
    });
    const psbt = tx.toPSBT();
    const valid = TapTreeCoder.encode(toBIP371TapTree(script.encode()));
    expect(tapTree.length).toBe(valid.length);
    const at = indexOf(psbt, valid);
    expect(at).toBeGreaterThan(0);
    psbt.set(tapTree, at);
    return { psbt, txid: tx.id };
}

describe("Transaction.fromPSBT with a legacy PSBT_OUT_TAP_TREE", () => {
    it.each([1, 3, 6, 8])("decodes %i legacy leaves with real depths", (n) => {
        const script = scriptWithLeaves(n);
        const { psbt, txid } = psbtWithOutputTapTree(script, script.encode());

        expect(() => BtcSignerTransaction.fromPSBT(psbt)).toThrow(/tapTree/);

        const tx = Transaction.fromPSBT(psbt);
        expect(tx.id).toBe(txid);
        expect(tx.getOutput(0).tapTree).toEqual(toBIP371TapTree(script.encode()));
    });

    it("leaves other invalid tap trees rejected", () => {
        const script = scriptWithLeaves(3);
        const notLegacy = TapTreeCoder.encode(
            TapTreeCoder.decode(script.encode()).map((leaf, i) => ({
                ...leaf,
                depth: i === 0 ? 2 : 1,
            })),
        );
        const { psbt } = psbtWithOutputTapTree(script, notLegacy);

        expect(() => Transaction.fromPSBT(psbt)).toThrow(/tapTree/);
    });

    it("decodes valid PSBTs unchanged", () => {
        const script = scriptWithLeaves(6);
        const valid = TapTreeCoder.encode(toBIP371TapTree(script.encode()));
        const { psbt, txid } = psbtWithOutputTapTree(script, valid);

        const tx = Transaction.fromPSBT(psbt);
        expect(tx.id).toBe(txid);
        expect(hex.encode(tx.toPSBT())).toBe(hex.encode(psbt));
    });
});
