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
import {
    ArkTapscript,
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
        const leaves = decodeTaprootTree(tapTree);
        return new VtxoScript(leaves);
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

    encode(): Bytes {
        const tapTree = encodeTaprootTree(this.scripts);
        return tapTree;
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

function decodeTaprootTree(tapTree: Bytes): Uint8Array[] {
    let offset = 0;
    const scripts: Uint8Array[] = [];

    // Read number of leaves
    const [numLeaves, numLeavesSize] = decodeCompactSizeUint(tapTree, offset);
    offset += numLeavesSize;

    // Read each leaf
    for (let i = 0; i < numLeaves; i++) {
        // Skip depth (1 byte)
        offset += 1;

        // Skip leaf version (1 byte)
        offset += 1;

        // Read script length
        const [scriptLength, scriptLengthSize] = decodeCompactSizeUint(
            tapTree,
            offset
        );
        offset += scriptLengthSize;

        // Read script content
        const script = tapTree.slice(offset, offset + scriptLength);
        scripts.push(script);
        offset += scriptLength;
    }

    return scripts;
}

function decodeCompactSizeUint(
    data: Uint8Array,
    offset: number
): [number, number] {
    const firstByte = data[offset];

    if (firstByte < 0xfd) {
        return [firstByte, 1];
    } else if (firstByte === 0xfd) {
        const value = new DataView(data.buffer).getUint16(offset + 1, true);
        return [value, 3];
    } else if (firstByte === 0xfe) {
        const value = new DataView(data.buffer).getUint32(offset + 1, true);
        return [value, 5];
    } else {
        const value = Number(
            new DataView(data.buffer).getBigUint64(offset + 1, true)
        );
        return [value, 9];
    }
}

function encodeTaprootTree(leaves: Uint8Array[]): Uint8Array {
    const chunks: Uint8Array[] = [];

    // Write number of leaves as compact size uint
    chunks.push(encodeCompactSizeUint(leaves.length));

    for (const tapscript of leaves) {
        // Write depth (always 1 for now)
        chunks.push(new Uint8Array([1]));

        // Write leaf version (0xc0 for tapscript)
        chunks.push(new Uint8Array([0xc0]));

        // Write script length and script
        chunks.push(encodeCompactSizeUint(tapscript.length));
        chunks.push(tapscript);
    }

    // Concatenate all chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }

    return result;
}

function encodeCompactSizeUint(value: number): Uint8Array {
    if (value < 0xfd) {
        return new Uint8Array([value]);
    } else if (value <= 0xffff) {
        const buffer = new Uint8Array(3);
        buffer[0] = 0xfd;
        new DataView(buffer.buffer).setUint16(1, value, true);
        return buffer;
    } else if (value <= 0xffffffff) {
        const buffer = new Uint8Array(5);
        buffer[0] = 0xfe;
        new DataView(buffer.buffer).setUint32(1, value, true);
        return buffer;
    } else {
        const buffer = new Uint8Array(9);
        buffer[0] = 0xff;
        new DataView(buffer.buffer).setBigUint64(1, BigInt(value), true);
        return buffer;
    }
}
