import { scriptError } from "./errors";
import { taggedHash } from "./tx";

function compare(a: Uint8Array, b: Uint8Array): number {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}

// Siblings are ordered by byte value, not by direction bits. An empty leaf tag takes leafData as
// the leaf hash itself, which lets a root feed the next proof.
export function merkleBranchRoot(
    leafTag: Uint8Array,
    leafData: Uint8Array,
    branchTag: Uint8Array,
    proof: Uint8Array,
): Uint8Array {
    if (leafTag.length === 0 && leafData.length !== 32) {
        throw scriptError(
            "ErrInvalidStackOperation",
            "raw hash mode requires leaf_data to be 32 bytes",
        );
    }
    let current = leafTag.length === 0 ? leafData : taggedHash(leafTag, leafData);
    for (let i = 0; i < proof.length; i += 32) {
        const sibling = proof.subarray(i, i + 32);
        current =
            compare(current, sibling) < 0
                ? taggedHash(branchTag, current, sibling)
                : taggedHash(branchTag, sibling, current);
    }
    return current;
}
