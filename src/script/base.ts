import {
    Address,
    p2tr,
    TAP_LEAF_VERSION,
    taprootListToTree,
} from "@scure/btc-signer/payment";
import {
    BTC_NETWORK,
    Bytes,
    TAPROOT_UNSPENDABLE_KEY,
} from "@scure/btc-signer/utils";
import { ArkAddress } from "./address";
import { Script } from "@scure/btc-signer";
import { hex } from "@scure/base";

export type TapLeafScript = [
    {
        version: number;
        internalKey: Bytes;
        merklePath: Bytes[];
    },
    Bytes,
];

export function scriptFromTapLeafScript(leaf: TapLeafScript): Bytes {
    return leaf[1].subarray(0, leaf[1].length - 1); // remove the version byte
}

export class VtxoScript {
    readonly leaves: TapLeafScript[];
    readonly tweakedPublicKey: Bytes;

    static decode(scripts: string[]): VtxoScript {
        return new VtxoScript(scripts.map(hex.decode));
    }

    constructor(readonly scripts: Bytes[]) {
        const tapTree = taprootListToTree(
            scripts.map((script) => ({ script, leafVersion: TAP_LEAF_VERSION }))
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

    encode(): string[] {
        return this.scripts.map(hex.encode);
    }

    address(prefix: string, serverPubKey: Bytes): ArkAddress {
        return new ArkAddress(serverPubKey, this.tweakedPublicKey, prefix);
    }

    get pkScript(): Bytes {
        return Script.encode(["OP_1", this.tweakedPublicKey]);
    }

    onchainAddress(network: BTC_NETWORK): string {
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
}

export type EncodedVtxoScript = { scripts: ReturnType<VtxoScript["encode"]> };
