import { schnorr } from "@noble/curves/secp256k1";
import { hex } from "@scure/base";
import { Bytes, compareBytes } from "@scure/btc-signer/utils.js";
import { BufferReader, BufferWriter } from "./utils";

/**
 * Metadata represents a key-value pair.
 * @param key - the key
 * @param value - the value
 */
export class Metadata {
    private constructor(
        readonly key: Uint8Array,
        readonly value: Uint8Array
    ) {}

    static create(key: Bytes, value: Bytes): Metadata {
        const md = new Metadata(key, value);
        md.validate();
        return md;
    }

    static fromString(s: string): Metadata {
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid metadata format, must be hex");
        }
        return Metadata.fromBytes(buf);
    }

    static fromBytes(buf: Uint8Array): Metadata {
        if (!buf || buf.length === 0) {
            throw new Error("missing metadata");
        }
        const reader = new BufferReader(buf);
        return Metadata.fromReader(reader);
    }

    serialize(): Uint8Array {
        const writer = new BufferWriter();
        this.serializeTo(writer);
        return writer.toBytes();
    }

    toString(): string {
        return hex.encode(this.serialize());
    }

    get keyString(): string {
        return new TextDecoder().decode(this.key);
    }

    get valueString(): string {
        return new TextDecoder().decode(this.value);
    }

    validate(): void {
        if (this.key.length === 0) {
            throw new Error("missing metadata key");
        }
        if (this.value.length === 0) {
            throw new Error("missing metadata value");
        }
    }

    static fromReader(reader: BufferReader): Metadata {
        let key: Uint8Array;
        let value: Uint8Array;

        try {
            key = reader.readVarSlice();
        } catch {
            throw new Error("invalid metadata length");
        }

        try {
            value = reader.readVarSlice();
        } catch {
            throw new Error("invalid metadata length");
        }

        const md = new Metadata(key, value);
        md.validate();
        return md;
    }

    serializeTo(writer: BufferWriter): void {
        writer.writeVarSlice(this.key);
        writer.writeVarSlice(this.value);
    }
}

export class MetadataList {
    static readonly ARK_LEAF_TAG = "ArkadeAssetLeaf";
    static readonly ARK_BRANCH_TAG = "ArkadeAssetBranch";
    static readonly ARK_LEAF_VERSION = 0x00;

    constructor(readonly items: Metadata[]) {}

    static fromString(s: string): MetadataList {
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid metadata list format");
        }
        return MetadataList.fromBytes(buf);
    }

    static fromBytes(buf: Uint8Array): MetadataList {
        if (!buf || buf.length === 0) {
            throw new Error("missing metadata list");
        }
        const reader = new BufferReader(buf);
        return MetadataList.fromReader(reader);
    }

    static fromReader(reader: BufferReader): MetadataList {
        const count = Number(reader.readVarUint());
        const items = Array.from({ length: count }, () =>
            Metadata.fromReader(reader)
        );
        return new MetadataList(items);
    }

    serializeTo(writer: BufferWriter): void {
        writer.writeVarUint(this.items.length);
        for (const item of this) {
            item.serializeTo(writer);
        }
    }

    serialize(): Uint8Array {
        const writer = new BufferWriter();
        this.serializeTo(writer);
        return writer.toBytes();
    }

    [Symbol.iterator](): Iterator<Metadata> {
        return this.items[Symbol.iterator]();
    }

    get length(): number {
        return this.items.length;
    }

    hash(): Uint8Array {
        if (this.items.length === 0) throw new Error("missing metadata list");
        const levels = buildMetadataMerkleTree(this.items);
        return levels[levels.length - 1][0]; // the last level is the root
    }
}

function computeMetadataLeafHash(md: Metadata): Uint8Array {
    const writer = new BufferWriter();
    writer.writeByte(MetadataList.ARK_LEAF_VERSION);
    writer.writeVarSlice(md.key);
    writer.writeVarSlice(md.value);
    return schnorr.utils.taggedHash(
        MetadataList.ARK_LEAF_TAG,
        writer.toBytes()
    );
}

function computeMetadataBranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
    const [smaller, larger] = compareBytes(a, b) === -1 ? [a, b] : [b, a];
    return schnorr.utils.taggedHash(
        MetadataList.ARK_BRANCH_TAG,
        smaller,
        larger
    );
}

function buildMetadataMerkleTree(leaves: Metadata[]): Uint8Array[][] {
    if (leaves.length === 0) return [];
    const leafHashes = leaves.map(computeMetadataLeafHash);
    const levels: Uint8Array[][] = [leafHashes];

    let current = leafHashes;
    while (current.length > 1) {
        const next: Uint8Array[] = [];
        for (let i = 0; i < current.length; i += 2) {
            if (i + 1 < current.length) {
                next.push(
                    computeMetadataBranchHash(current[i], current[i + 1])
                );
            } else {
                next.push(current[i]);
            }
        }
        levels.push(next);
        current = next;
    }

    return levels;
}
