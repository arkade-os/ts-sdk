import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { p2tr, TAPROOT_UNSPENDABLE_KEY } from "@scure/btc-signer";
import { assembleBtcdTaprootTree, VtxoScript } from "../src";

/**
 * Sanity tests for the btcd-compatible Taproot script tree builder.
 *
 * These exercise leaf counts that would diverge between scure-btc-signer's
 * Huffman builder (`taprootListToTree`) and arkd's btcd builder
 * (`txscript.AssembleTaprootScriptTree`). For power-of-2 counts both
 * algorithms produce the same balanced tree; for any other count they
 * differ. We don't assert specific tap keys here (they're proven by the
 * VtxoScript fixture tests in `tapscript.test.ts`), but we DO assert:
 *
 *   1. The function accepts arbitrary leaf counts and produces a tree.
 *   2. p2tr accepts the produced tree and returns N tap-leaf scripts.
 *   3. VtxoScript can be round-trip encoded/decoded with the new
 *      algorithm and yield the same tap key.
 */

function dummyScript(byte: number): Uint8Array {
    // Minimal valid push: `OP_DATA_1 <byte>`.
    return new Uint8Array([0x01, byte]);
}

function makeScripts(count: number): Uint8Array[] {
    return Array.from({ length: count }, (_, i) => dummyScript(i));
}

describe("assembleBtcdTaprootTree", () => {
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15, 16, 17, 32]) {
        it(`builds a valid tree for ${count} leaves`, () => {
            const scripts = makeScripts(count);
            const tree = assembleBtcdTaprootTree(scripts);
            const payment = p2tr(TAPROOT_UNSPENDABLE_KEY, tree, undefined, true);
            expect(payment.tapLeafScript).toBeTruthy();
            expect(payment.tapLeafScript!.length).toBe(count);
        });
    }

    it("throws on empty input", () => {
        expect(() => assembleBtcdTaprootTree([])).toThrow();
    });

    it("VtxoScript encode→decode round-trips the tap key for any leaf count", () => {
        for (const count of [3, 5, 7, 9, 10, 11, 13]) {
            const scripts = makeScripts(count);
            const original = new VtxoScript(scripts);
            const roundtripped = VtxoScript.decode(original.encode());
            expect(hex.encode(roundtripped.tweakedPublicKey)).toBe(
                hex.encode(original.tweakedPublicKey),
            );
            expect(hex.encode(roundtripped.pkScript)).toBe(hex.encode(original.pkScript));
        }
    });
});
