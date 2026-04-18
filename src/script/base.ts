import {
    Script,
    Address,
    p2tr,
    taprootListToTree,
    TAPROOT_UNSPENDABLE_KEY,
    NETWORK,
} from "@scure/btc-signer";
import { TAP_LEAF_VERSION } from "@scure/btc-signer/payment.js";
import { PSBTOutput } from "@scure/btc-signer/psbt.js";
import { Bytes } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import { ArkAddress } from "./address";
import { timelockToSequence } from "../utils/timelock";
import {
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    CSVMultisigTapscript,
} from "./tapscript";

export type TapLeafScript = [
    {
        version: number;
        internalKey: Bytes;
        merklePath: Bytes[];
    },
    Bytes,
];

export const TapTreeCoder: (typeof PSBTOutput.tapTree)[2] =
    PSBTOutput.tapTree[2];

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

    /**
     * Decode a virtual output script from an encoded TapTree.
     *
     * @param tapTree - Encoded TapTree bytes
     * @returns Decoded virtual output script
     * @throws Error if the TapTree cannot be decoded into a valid script set
     * @see encode
     */
    static decode(tapTree: Bytes): VtxoScript {
        const leaves = TapTreeCoder.decode(tapTree);
        const scripts = leaves.map((leaf) => leaf.script);
        return new VtxoScript(scripts);
    }

    /**
     * Create a virtual output script from its tapleaf scripts.
     *
     * @param scripts - Raw tapscript bytes for each leaf
     * @throws Error if the provided leaves cannot produce a valid Taproot tree
     */
    constructor(readonly scripts: Bytes[]) {
        // reverse the scripts if the number of scripts is odd
        // this is to be compatible with arkd algorithm computing taproot tree from list of tapscripts
        // the scripts must be reversed only HERE while we compute the tweaked public key
        // but the original order should be preserved while encoding as taptree
        // note: .slice().reverse() is used instead of .reverse() to avoid mutating the original array
        const list =
            scripts.length % 2 !== 0 ? scripts.slice().reverse() : scripts;

        const tapTree = taprootListToTree(
            list.map((script) => ({
                script,
                leafVersion: TAP_LEAF_VERSION,
            }))
        );

        const payment = p2tr(TAPROOT_UNSPENDABLE_KEY, tapTree, undefined, true);

        if (
            !payment.tapLeafScript ||
            payment.tapLeafScript.length !== scripts.length
        ) {
            throw new Error("invalid scripts");
        }

        this.leaves = payment.tapLeafScript;
        this.tweakedPublicKey = payment.tweakedPubkey;
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
                script,
            }))
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
    address(prefix: string, serverPubKey: Bytes): ArkAddress {
        return new ArkAddress(serverPubKey, this.tweakedPublicKey, prefix);
    }

    get pkScript(): Bytes {
        return Script.encode(["OP_1", this.tweakedPublicKey]);
    }

    /**
     * Build the Taproot onchain address corresponding to this virtual output script.
     *
     * @param network - Bitcoin network descriptor
     * @returns Taproot onchain address
     * @see address
     */
    onchainAddress(network: typeof NETWORK): string {
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
            (leaf) => hex.encode(scriptFromTapLeafScript(leaf)) === scriptHex
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
    exitPaths(): Array<
        CSVMultisigTapscript.Type | ConditionCSVMultisigTapscript.Type
    > {
        const paths: Array<
            CSVMultisigTapscript.Type | ConditionCSVMultisigTapscript.Type
        > = [];
        for (const leaf of this.leaves) {
            try {
                const tapscript = CSVMultisigTapscript.decode(
                    scriptFromTapLeafScript(leaf)
                );
                paths.push(tapscript);
                continue;
            } catch (e) {
                try {
                    const tapscript = ConditionCSVMultisigTapscript.decode(
                        scriptFromTapLeafScript(leaf)
                    );
                    paths.push(tapscript);
                } catch (e) {
                    continue;
                }
            }
        }
        return paths;
    }
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
        const script = scriptWithLeafVersion.subarray(
            0,
            scriptWithLeafVersion.length - 1
        );
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
