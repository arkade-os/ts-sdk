import {
    Script,
    Address,
    p2tr,
    taprootListToTree,
    TAPROOT_UNSPENDABLE_KEY,
    NETWORK,
} from "@scure/btc-signer";
import * as bip68 from "bip68";
import { TAP_LEAF_VERSION } from "@scure/btc-signer/payment.js";
import { PSBTOutput } from "@scure/btc-signer/psbt.js";
import { Bytes } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import { ArkAddress } from "./address";
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
 * It is used to create vtxo scripts.
 *
 * @example
 * ```typescript
 * const vtxoScript = new VtxoScript([new Uint8Array(32), new Uint8Array(32)]);
 */
export class VtxoScript {
    readonly leaves: TapLeafScript[];
    readonly tweakedPublicKey: Bytes;

    static decode(tapTree: Bytes): VtxoScript {
        const leaves = TapTreeCoder.decode(tapTree);
        const scripts = leaves.map((leaf) => leaf.script);
        return new VtxoScript(scripts);
    }

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

    address(prefix: string, serverPubKey: Bytes): ArkAddress {
        return new ArkAddress(serverPubKey, this.tweakedPublicKey, prefix);
    }

    get pkScript(): Bytes {
        return Script.encode(["OP_1", this.tweakedPublicKey]);
    }

    onchainAddress(network: typeof NETWORK): string {
        return Address(network).encode({
            type: "tr",
            pubkey: this.tweakedPublicKey,
        });
    }

    findLeaf(scriptHex: string): TapLeafScript {
        const leaf = this.leaves.find(
            (leaf) => hex.encode(scriptFromTapLeafScript(leaf)) === scriptHex
        )!;
        if (!leaf) {
            throw new Error(`leaf '${scriptHex}' not found`);
        }
        return leaf;
    }

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
            sequence = bip68.encode(
                params.timelock.type === "blocks"
                    ? { blocks: Number(params.timelock.value) }
                    : { seconds: Number(params.timelock.value) }
            );
        } catch {
            const params = CLTVMultisigTapscript.decode(script).params;
            sequence = Number(params.absoluteTimelock);
        }
    } catch {}

    return sequence;
}
