import { TAP_LEAF_VERSION } from "@scure/btc-signer/payment.js";
import { Bytes } from "@scure/btc-signer/utils.js";

/**
 * A leaf node in the Taproot script tree, as consumed by
 * `@scure/btc-signer`'s `p2tr(internalKey, tree, ...)`.
 */
export interface TaprootLeaf {
    script: Bytes;
    leafVersion: number;
}

/**
 * Internal tree node shape consumed by `@scure/btc-signer`'s `p2tr`:
 *   - A leaf is `{ script, leafVersion }`
 *   - A branch is a 2-element tuple `[leftNode, rightNode]` of nodes
 */
export type TaprootTreeNode = TaprootLeaf | [TaprootTreeNode, TaprootTreeNode];

/**
 * Assemble a Taproot script tree from a flat list of scripts using the
 * exact algorithm arkd's btcd dependency uses
 * (`txscript.AssembleTaprootScriptTree`, see
 * https://github.com/btcsuite/btcd/blob/master/txscript/taproot.go).
 *
 * The algorithm:
 *
 *   Phase 1 — pair leaves left-to-right:
 *     for i := 0; i < len(leaves); i += 2:
 *       if i is the last index (odd leaf at end):
 *         merge with the LAST branch built so far (do NOT pair as a fresh leaf)
 *       else:
 *         create a new branch from (leaves[i], leaves[i+1])
 *
 *   Phase 2 — FIFO-queue merge branches:
 *     while branches has ≥ 2 items:
 *       take front two, combine into a new branch, push to back of queue
 *
 * This matters because `@scure/btc-signer`'s `taprootListToTree` builds a
 * Huffman tree (weight-1 leaves combine by smallest-weight pairs). For
 * power-of-2 leaf counts both algorithms happen to produce the same
 * perfectly-balanced binary tree and agree. For any other count they
 * produce DIFFERENT shapes → different merkle roots → different taproot
 * output keys → arkd rejects spends with `INVALID_PSBT_INPUT`.
 *
 * Reproducing btcd's algorithm here lets the SDK construct taptrees that
 * arkd accepts for arbitrary leaf counts.
 *
 * @param scripts - Raw tapscript bytes for each leaf, in the order they
 *                  should be encoded in the TapTree PSBT field.
 * @returns The nested-tuple form `p2tr` accepts.
 */
export function assembleBtcdTaprootTree(scripts: Bytes[]): TaprootTreeNode {
    if (scripts.length === 0) {
        throw new Error("assembleBtcdTaprootTree: empty scripts list");
    }

    const leaves: TaprootLeaf[] = scripts.map((script) => ({
        script,
        leafVersion: TAP_LEAF_VERSION,
    }));

    if (leaves.length === 1) {
        return leaves[0];
    }

    // ── Phase 1: pair leaves left-to-right ─────────────────────────────
    const branches: TaprootTreeNode[] = [];
    for (let i = 0; i < leaves.length; i += 2) {
        if (i === leaves.length - 1) {
            // Odd leaf at end: merge into the LAST branch built so far.
            // Mirrors btcd's
            //   branches[len(branches)-1] = NewTapBranch(branchToMerge, leaf)
            const last = branches.pop();
            if (last === undefined) {
                // Defensive — caller should have provided ≥ 2 leaves.
                throw new Error(
                    `assembleBtcdTaprootTree: unexpected odd leaf at i=${i} with no prior branch`,
                );
            }
            branches.push([last, leaves[i]]);
        } else {
            // Pair two consecutive leaves into a new branch.
            branches.push([leaves[i], leaves[i + 1]]);
        }
    }

    // ── Phase 2: FIFO-queue merge branches ─────────────────────────────
    // Take front two, combine, push to back. Stops when one branch remains.
    while (branches.length >= 2) {
        const left = branches.shift()!;
        const right = branches.shift()!;
        branches.push([left, right]);
    }

    return branches[0];
}
