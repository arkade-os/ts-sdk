import { hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";
import {
    BufferReader,
    BufferWriter,
    serializeVarSlice,
    serializeVarUint,
} from "./utils";

export class Metadata {
    readonly key: Uint8Array;
    readonly value: Uint8Array;

    private constructor(key: Uint8Array, value: Uint8Array) {
        this.key = key;
        this.value = value;
    }

    static create(key: string, value: string): Metadata {
        const md = new Metadata(
            new TextEncoder().encode(key),
            new TextEncoder().encode(value)
        );
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
        writer.write(serializeVarSlice(this.key));
        writer.write(serializeVarSlice(this.value));
    }
}

export function generateMetadataListHash(
    metadata: Metadata[]
): Uint8Array | null {
    if (!metadata || metadata.length === 0) {
        return null;
    }

    const sorted = [...metadata].sort((a, b) => {
        const keyA = new TextDecoder().decode(a.key);
        const keyB = new TextDecoder().decode(b.key);
        return keyB.localeCompare(keyA);
    });

    let buf = new Uint8Array(0);
    for (const m of sorted) {
        const hash = m.hash();
        const newBuf = new Uint8Array(buf.length + hash.length);
        newBuf.set(buf);
        newBuf.set(hash, buf.length);
        buf = newBuf;
    }

    return sha256(buf);
}

export function serializeMetadataList(
    metadata: Metadata[],
    writer: BufferWriter
): void {
    writer.write(serializeVarUint(metadata.length));

    const sorted = [...metadata].sort((a, b) => {
        const keyA = new TextDecoder().decode(a.key);
        const keyB = new TextDecoder().decode(b.key);
        return keyB.localeCompare(keyA);
    });

    for (const m of sorted) {
        m.serializeTo(writer);
    }
}

export function deserializeMetadataList(reader: BufferReader): Metadata[] {
    const count = Number(reader.readVarUint());
    const metadata: Metadata[] = [];
    for (let i = 0; i < count; i++) {
        metadata.push(Metadata.fromReader(reader));
    }
    return metadata;
}
