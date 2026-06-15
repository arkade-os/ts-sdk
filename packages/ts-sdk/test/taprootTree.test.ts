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
 * differ.
 *
 * Correctness of the derived tap key for the divergent counts is NOT
 * asserted here — a round-trip through the same builder proves only that
 * the builder is deterministic, not that it matches btcd. The authoritative
 * checks are the golden vectors in `fixtures/vtxoscript.json`, exercised by
 * `tapscript.test.ts`: their `taprootKey`s were generated independently with
 * btcd's `txscript.AssembleTaprootScriptTree` + `ComputeTaprootOutputKey`
 * (using scure's `TAPROOT_UNSPENDABLE_KEY` as the internal key), so they fail
 * if our builder produces a wrong tree. This file only asserts:
 *
 *   1. The function accepts arbitrary leaf counts and produces a tree.
 *   2. p2tr accepts the produced tree and returns N tap-leaf scripts.
 *   3. VtxoScript serialization (encode→decode) preserves the script set.
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

    // Serialization round-trip: encode() drops the tree shape (flat depth-1
    // TapTree), so decode() rebuilds it via the same btcd builder. This
    // asserts the script set survives the round-trip, NOT that the tap key is
    // correct — that is covered by the golden vectors in vtxoscript.json.
    it("VtxoScript encode→decode preserves the script set", () => {
        for (const count of [3, 10]) {
            const original = new VtxoScript(makeScripts(count));
            const roundtripped = VtxoScript.decode(original.encode());
            expect(roundtripped.scripts.map(hex.encode)).toEqual(original.scripts.map(hex.encode));
            expect(hex.encode(roundtripped.tweakedPublicKey)).toBe(
                hex.encode(original.tweakedPublicKey),
            );
        }
    });
});
