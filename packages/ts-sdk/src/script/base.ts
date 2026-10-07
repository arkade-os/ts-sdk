import { Address, p2tr, taprootNumsKey, NETWORK } from "@scure/btc-signer";
import { TAP_LEAF_VERSION } from "@scure/btc-signer/payment.js";
import { PSBTOutput } from "@scure/btc-signer/psbt.js";
import { VarBytes } from "@scure/btc-signer/script.js";
import { Bytes } from "@scure/btc-signer/utils.js";
import * as P from "micro-packed";
import { hex } from "@scure/base";
import { ArkAddress } from "./address";
import { timelockToSequence } from "../utils/timelock";
import {
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    CSVMultisigTapscript,
} from "./tapscript";
import { assembleBtcdTaprootTree, btcdLeafLayout } from "./taprootTree";
import { DEFAULT_NETWORK } from "../networks";

export type TapLeafScript = [
    {
        version: number;
        internalKey: Bytes;
        merklePath: Bytes[];
    },
    Bytes,
];

export const TapTreeCoder: (typeof PSBTOutput.tapTree)[2] = P.array(
    null,
    P.struct({ depth: P.U8, version: P.U8, script: VarBytes }),
);

export function scriptFromTapLeafScript(leaf: TapLeafScript): Bytes {
    return leaf[1].subarray(0, leaf[1].length - 1); // remove the version byte
}

/**
 * VtxoScript is a script that contains a list of tapleaf scripts.
 * It is used to create virtual output scripts.
 *
 * @see ArkAddress
 *
 * @example
 * ```typescript
 * const vtxoScript = new VtxoScript([new Uint8Array(32), new Uint8Array(32)]);
 * ```
 */
export class VtxoScript {
    readonly leaves: TapLeafScript[];
    readonly tweakedPublicKey: Bytes;
    readonly pkScript: Bytes;

    /**
     * Decode a virtual output script from an encoded TapTree.
     *
     * Accepts both the {@link encode} form (leaves in construction order, all
     * at depth 1) and the BIP-371 form {@link toBIP371TapTree} writes (leaves
     * in the tree's DFS order with their real depths). For some leaf counts
     * (6, 7, 10, ...) the two orders differ, so a BIP-371 tree is mapped back
     * to construction order before the tree is rebuilt.
     *
     * @param tapTree - Encoded TapTree bytes
     * @returns Decoded virtual output script
     * @throws Error if the TapTree cannot be decoded into a valid script set,
     *         or its depths are not the shape `assembleBtcdTaprootTree` builds
     * @see encode
     */
    static decode(tapTree: Bytes): VtxoScript {
        const leaves = TapTreeCoder.decode(tapTree);
        if (leaves.every((leaf) => leaf.depth === 1)) {
            return new VtxoScript(leaves.map((leaf) => leaf.script));
        }
        const layout = btcdLeafLayout(leaves.length);
        if (layout.some((slot, i) => slot.depth !== leaves[i].depth)) {
            throw new Error("tapTree: leaf depths do not match the btcd tree shape");
        }
        const scripts = new Array<Bytes>(leaves.length);
        layout.forEach((slot, i) => {
            scripts[slot.index] = leaves[i].script;
        });
        return new VtxoScript(scripts);
    }

    /**
     * Create a virtual output script from its tapleaf scripts.
     *
     * The Taproot script tree is assembled using btcd's algorithm
     * (`txscript.AssembleTaprootScriptTree`) so the derived taproot output
     * key agrees with arkd for any leaf count. `@scure/btc-signer`'s
     * default `taprootListToTree` is a Huffman builder that only agrees
     * with arkd for power-of-2 leaf counts.
     *
     * @param scripts - Raw tapscript bytes for each leaf
     * @throws Error if the provided leaves cannot produce a valid Taproot tree
     */
    constructor(readonly scripts: Bytes[]) {
        const tapTree = assembleBtcdTaprootTree(scripts);

        const payment = p2tr(taprootNumsKey(), tapTree, undefined, true);

        if (!payment.tapLeafScript || payment.tapLeafScript.length !== scripts.length) {
            throw new Error("invalid scripts");
        }

        this.leaves = payment.tapLeafScript;
        this.tweakedPublicKey = payment.tweakedPubkey;
        this.pkScript = payment.script;
    }

    /**
     * Encode the virtual output script to a TapTree byte representation.
     *
     * @returns Encoded TapTree bytes
     * @see decode
     */
    encode(): Bytes {
        const tapTree = TapTreeCoder.encode(
            this.scripts.map((script) => ({
                depth: 1,
                version: TAP_LEAF_VERSION,
                script: script as Uint8Array<ArrayBuffer>,
            })),
        );
        return tapTree;
    }

    /**
     * Build the Arkade address corresponding to this virtual output script.
     *
     * @param prefix - Bech32 human-readable prefix
     * @param serverPubKey - 32-byte Arkade server public key
     * @returns Arkade address for this script
     * @see ArkAddress
     */
    address(prefix: string = DEFAULT_NETWORK.hrp, serverPubKey: Bytes): ArkAddress {
        return new ArkAddress(serverPubKey, this.tweakedPublicKey, prefix);
    }

    /**
     * Build the Taproot onchain address corresponding to this virtual output script.
     *
     * @param network - Bitcoin network descriptor
     * @returns Taproot onchain address
     * @see address
     */
    onchainAddress(network: typeof NETWORK = DEFAULT_NETWORK): string {
        return Address(network).encode({
            type: "tr",
            pubkey: this.tweakedPublicKey,
        });
    }

    /**
     * Look up a tapleaf script by its hex-encoded tapscript body.
     *
     * @param scriptHex - Hex-encoded tapscript body without the leaf version byte
     * @returns Matching tapleaf script
     * @throws Error if no matching leaf exists
     */
    findLeaf(scriptHex: string): TapLeafScript {
        const leaf = this.leaves.find(
            (leaf) => hex.encode(scriptFromTapLeafScript(leaf)) === scriptHex,
        )!;
        if (!leaf) {
            throw new Error(`leaf '${scriptHex}' not found`);
        }
        return leaf;
    }

    /**
     * Return all unilateral exit paths embedded in the virtual output script.
     *
     * @returns CSV-based exit paths found in the leaves
     * @see getSequence
     */
    exitPaths(): Array<CSVMultisigTapscript.Type | ConditionCSVMultisigTapscript.Type> {
        const paths: Array<CSVMultisigTapscript.Type | ConditionCSVMultisigTapscript.Type> = [];
        for (const leaf of this.leaves) {
            try {
                const script = scriptFromTapLeafScript(leaf);
                if (CSVMultisigTapscript.isScriptValid(script) === true) {
                    const tapScript = CSVMultisigTapscript.decode(script);
                    paths.push(tapScript);
                } else if (ConditionCSVMultisigTapscript.isScriptValid(script) === true) {
                    const tapScript = ConditionCSVMultisigTapscript.decode(script);
                    paths.push(tapScript);
                }
            } catch (e) {
                console.debug("Failed to decode script", e);
            }
        }
        return paths;
    }
}

/**
 * Convert a `VtxoScript.encode()`-produced TapTree into a BIP-371
 * (`PSBT_OUT_TAP_TREE`) compliant leaf list: entries in left-to-right DFS
 * order, each carrying its *actual* depth in the btcd-assembled tree.
 *
 * `VtxoScript.encode()` stores leaves in the caller's original order with a
 * placeholder `depth: 1` — a format `VtxoScript.decode()` can losslessly
 * invert by re-running `assembleBtcdTaprootTree` over that same order (it
 * decodes this function's output too), but NOT a valid BIP-371 field: for non-power-of-2 leaf counts (e.g. 3, 6) the
 * tree is neither flat nor built in that original order (the algorithm's
 * FIFO merge phase can reorder leaves for counts like 6), so per-index
 * depths cannot be guessed from leaf position. This rebuilds the exact same
 * `VtxoScript` (deterministic from the same script list) to read genuine
 * depths off its `leaves` (populated by `p2tr()` from the real tree), in
 * the tree's true DFS order.
 *
 * @param tapTree - Encoded TapTree bytes from `VtxoScript.encode()`
 * @returns BIP-371-compliant TapTree leaves, ready for a PSBT output's
 *          `tapTree` field
 */
export function toBIP371TapTree(tapTree: Bytes): ReturnType<typeof TapTreeCoder.decode> {
    const scripts = TapTreeCoder.decode(tapTree).map((leaf) => leaf.script);
    const vtxoScript = new VtxoScript(scripts);
    return vtxoScript.leaves.map((leaf) => ({
        depth: leaf[0].merklePath.length,
        version: TAP_LEAF_VERSION,
        script: scriptFromTapLeafScript(leaf) as Uint8Array<ArrayBuffer>,
    }));
}

export type EncodedVtxoScript = { tapTree: Bytes };

/**
 * Extract the timelock value encoded in a timelocked tapleaf, if any.
 *
 * The return value is unit-ambiguous: for a CSV leaf it is a BIP-68
 * nSequence (relative timelock); for a CLTV leaf it is an absolute
 * nLockTime. Callers must know which leaf shape they are inspecting to
 * interpret the number correctly, and must not copy a CSV result into
 * `Transaction.lockTime` (or vice versa).
 *
 * @param tapLeafScript - Tapleaf script to inspect
 * @returns The encoded timelock value, or `undefined` when neither a CSV
 *          nor CLTV path is present
 * @see VtxoScript.exitPaths
 */
// TODO(next-major): return a discriminated union
// (`{ kind: "relative", nSequence } | { kind: "absolute", lockTime }`)
// so callers can't conflate the two. Deferred because changing the
// return type is a breaking change.
export function getSequence(tapLeafScript: TapLeafScript): number | undefined {
    let sequence: number | undefined = undefined;

    try {
        const scriptWithLeafVersion = tapLeafScript[1];
        const script = scriptWithLeafVersion.subarray(0, scriptWithLeafVersion.length - 1);
        try {
            const params = CSVMultisigTapscript.decode(script).params;
            sequence = timelockToSequence(params.timelock);
        } catch {
            const params = CLTVMultisigTapscript.decode(script).params;
            sequence = Number(params.absoluteTimelock);
        }
    } catch {}

    return sequence;
}
