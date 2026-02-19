import { hex } from "@scure/base";
import { Bytes, sha256 } from "@scure/btc-signer/utils.js";
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

    hash(): Uint8Array {
        const combined = new Uint8Array(this.key.length + this.value.length);
        combined.set(this.key);
        combined.set(this.value, this.key.length);
        return sha256(combined);
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
        const items: Metadata[] = [];
        for (let i = 0; i < count; i++) {
            items.push(Metadata.fromReader(reader));
        }
        return new MetadataList(items);
    }

    serializeTo(writer: BufferWriter): void {
        writer.writeVarUint(this.items.length);
        for (const item of sortMetadata(this.items)) {
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
}

function sortMetadata(metadata: Metadata[]): Metadata[] {
    const decoder = new TextDecoder();
    return [...metadata].sort((a, b) => {
        const aKeyValue = decoder.decode(a.key) + decoder.decode(a.value);
        const bKeyValue = decoder.decode(b.key) + decoder.decode(b.value);
        return bKeyValue.localeCompare(aKeyValue);
    });
}
