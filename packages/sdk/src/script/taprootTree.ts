import { TAP_LEAF_VERSION } from "@scure/btc-signer/payment.js";
import { Bytes } from "@scure/btc-signer/utils.js";

/** A leaf node in the Taproot script tree, as consumed by `@scure/btc-signer`'s `p2tr`. */
export interface TaprootLeaf {
    script: Bytes;
    leafVersion: number;
}

/** A `p2tr` tree node: a leaf, or a `[left, right]` branch tuple. */
export type TaprootTreeNode = TaprootLeaf | [TaprootTreeNode, TaprootTreeNode];

/**
 * Assemble a Taproot script tree with btcd's `txscript.AssembleTaprootScriptTree` algorithm
 * (the one arkd uses).
 *
 * `@scure/btc-signer`'s `taprootListToTree` builds a Huffman tree instead; the two agree only for
 * power-of-2 leaf counts. Any other count yields a different merkle root → different output key
 * → arkd rejects spends with `INVALID_PSBT_INPUT`.
 *
 * @param scripts - Raw tapscript bytes per leaf, in TapTree PSBT field order.
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
            // Odd trailing leaf merges into the LAST branch, not a fresh pair (as btcd does).
            const last = branches.pop();
            if (last === undefined) {
                throw new Error(
                    `assembleBtcdTaprootTree: unexpected odd leaf at i=${i} with no prior branch`,
                );
            }
            branches.push([last, leaves[i]]);
        } else {
            branches.push([leaves[i], leaves[i + 1]]);
        }
    }

    // ── Phase 2: FIFO-queue merge branches ─────────────────────────────
    while (branches.length >= 2) {
        const left = branches.shift()!;
        const right = branches.shift()!;
        branches.push([left, right]);
    }

    return branches[0];
}
