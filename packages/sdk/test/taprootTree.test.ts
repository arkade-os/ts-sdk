import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { p2tr, taprootNumsKey } from "@scure/btc-signer";
import { assembleBtcdTaprootTree, Transaction, VtxoScript } from "../src";
import { btcdLeafLayout } from "../src/script/taprootTree";
import { TapTreeCoder, toBIP371TapTree } from "../src/script/base";

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
 * (using scure's `taprootNumsKey()` as the internal key), so they fail
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
            const payment = p2tr(taprootNumsKey(), tree, undefined, true);
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

// Rebuilds the nested-tuple tree `p2tr` expects from a flat BIP-371
// `PSBT_OUT_TAP_TREE` leaf list (DFS order + per-leaf depth), inverting the
// same preorder-depth encoding scure's own PSBT tapTree coder validates.
function treeFromBIP371Leaves(
    leaves: ReadonlyArray<{ depth: number; version: number; script: Uint8Array }>,
) {
    const stack: [number, unknown][] = [];
    for (const leaf of leaves) {
        let node: unknown = { script: leaf.script, leafVersion: leaf.version };
        let depth = leaf.depth;
        while (stack.length > 0 && stack[stack.length - 1][0] === depth) {
            const [, sibling] = stack.pop()!;
            node = [sibling, node];
            depth -= 1;
        }
        stack.push([depth, node]);
    }
    expect(stack).toHaveLength(1);
    return stack[0][1];
}

describe("VtxoScript.encode as a PSBT output tapTree", () => {
    it.each([1, 2, 3, 4, 5, 6, 7, 10])(
        "round-trips %i leaves through scure's BIP-371 coder with correct depths",
        (n) => {
            const script = new VtxoScript(
                Array.from({ length: n }, (_, i) => new Uint8Array([0x51 + i])),
            );
            const bip371Tree = toBIP371TapTree(script.encode());
            const tx = new Transaction();
            tx.addOutput({
                script: script.pkScript,
                amount: 1000n,
                tapTree: bip371Tree,
            });
            const back = Transaction.fromPSBT(tx.toPSBT());
            const roundtrippedLeaves = back.getOutput(0).tapTree;
            expect(roundtrippedLeaves?.map((leaf) => leaf.script).sort()).toEqual(
                [...script.scripts].sort(),
            );

            // The depths must describe the *actual* tree used to derive
            // `script.pkScript`/`tweakedPublicKey`, not just any valid binary
            // tree shape: rebuild the tree from the serialized depths and
            // verify it re-derives the same taproot output key.
            const rebuiltTree = treeFromBIP371Leaves(roundtrippedLeaves!);
            const rebuilt = p2tr(taprootNumsKey(), rebuiltTree, undefined, true);
            expect(hex.encode(rebuilt.tweakedPubkey)).toBe(hex.encode(script.tweakedPublicKey));
        },
    );
});

describe("VtxoScript.decode of a BIP-371 tapTree", () => {
    const scriptWithLeaves = (n: number) =>
        new VtxoScript(Array.from({ length: n }, (_, i) => new Uint8Array([0x51 + i])));

    // 6, 7, 10, 11 and 12 are the counts whose DFS order differs from
    // construction order, so decoding by leaf order alone derives another key.
    it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
        "rebuilds the same script from %i leaves",
        (n) => {
            const script = scriptWithLeaves(n);
            const bip371 = TapTreeCoder.encode(toBIP371TapTree(script.encode()));

            const decoded = VtxoScript.decode(bip371);
            expect(hex.encode(decoded.pkScript)).toBe(hex.encode(script.pkScript));
            expect(hex.encode(decoded.encode())).toBe(hex.encode(script.encode()));
        },
    );

    it("rebuilds the script from a PSBT output tapTree", () => {
        const script = scriptWithLeaves(6);
        const tx = new Transaction();
        tx.addOutput({
            script: script.pkScript,
            amount: 1000n,
            tapTree: toBIP371TapTree(script.encode()),
        });
        const tapTree = Transaction.fromPSBT(tx.toPSBT()).getOutput(0).tapTree!;

        const decoded = VtxoScript.decode(TapTreeCoder.encode(tapTree));
        expect(hex.encode(decoded.pkScript)).toBe(hex.encode(script.pkScript));
    });

    // arkd >= v0.9.14 (`txutils.TapTree.Encode`) writes leaves in
    // construction order with placeholder depths min(i + 1, n - 1).
    it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
        "decodes arkd's %i-leaf encoding in construction order",
        (n) => {
            const script = scriptWithLeaves(n);
            const tapTree = TapTreeCoder.encode(
                script.scripts.map((leafScript, i) => ({
                    depth: n === 1 ? 0 : Math.min(i + 1, n - 1),
                    version: 0xc0,
                    script: leafScript as Uint8Array<ArrayBuffer>,
                })),
            );

            expect(hex.encode(VtxoScript.decode(tapTree).pkScript)).toBe(
                hex.encode(script.pkScript),
            );
        },
    );

    it("decodes any other depth shape in construction order", () => {
        const script = scriptWithLeaves(3);
        // Valid BIP-371 shape, but not the one assembleBtcdTaprootTree builds.
        const tapTree = TapTreeCoder.encode(
            script.scripts.map((leafScript, i) => ({
                depth: [1, 2, 2][i],
                version: 0xc0,
                script: leafScript as Uint8Array<ArrayBuffer>,
            })),
        );

        expect(hex.encode(VtxoScript.decode(tapTree).pkScript)).toBe(hex.encode(script.pkScript));
    });

    // decode rebuilds every leaf as base tapscript, so another version would
    // derive a different key; it must fail on every decode path.
    it.each([
        ["flat", [1, 1, 1, 1, 1, 1]],
        ["BIP-371", btcdLeafLayout(6).map((slot) => slot.depth)],
        ["other", [1, 2, 3, 4, 5, 5]],
    ])("rejects a non-tapscript leaf version in a %s tree", (_, depths) => {
        const script = scriptWithLeaves(6);
        const tapTree = TapTreeCoder.encode(
            script.scripts.map((leafScript, i) => ({
                depth: depths[i],
                version: i === 3 ? 0xc2 : 0xc0,
                script: leafScript as Uint8Array<ArrayBuffer>,
            })),
        );

        expect(() => VtxoScript.decode(tapTree)).toThrow("unsupported tap leaf version 0xc2");
    });

    // Reordering is keyed on the depth sequence, so it must never match a
    // construction-order writer's depths when the two orders differ.
    it("never mistakes a construction-order encoding for the BIP-371 form", () => {
        for (let n = 1; n <= 256; n++) {
            const layout = btcdLeafLayout(n);
            if (layout.every((slot, i) => slot.index === i)) continue;
            const dfsDepths = layout.map((slot) => slot.depth);
            const constructionOrderWriters = [
                Array(n).fill(1), // VtxoScript.encode, rust-sdk, dotnet-sdk
                Array.from({ length: n }, (_, i) => Math.min(i + 1, n - 1)), // arkd
                Array.from({ length: n }, (_, i) => layout.find((s) => s.index === i)!.depth),
            ];
            for (const depths of constructionOrderWriters) {
                expect(depths).not.toEqual(dfsDepths);
            }
        }
    });
});
