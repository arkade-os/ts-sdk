import { BufferReader, BufferWriter } from "../asset/utils";
import type { ExtensionPacket } from "../packet";

/**
 * INTROSPECTOR_PACKET_TYPE is the TLV type for the Introspector Packet (0x01).
 */
export const INTROSPECTOR_PACKET_TYPE = 0x01;

/**
 * IntrospectorEntry represents a single entry in the Introspector Packet,
 * mapping a transaction input to its arkade script and witness data.
 */
export interface IntrospectorEntry {
    /** Transaction input index (u16 LE) */
    vin: number;
    /** Arkade Script bytecode */
    script: Uint8Array;
    /** Script witness data (serialized) */
    witness: Uint8Array;
}

/**
 * IntrospectorPacket implements ExtensionPacket for type 0x01.
 *
 * Internal wire format (inside TLV payload):
 *   compactSize(entry_count) + for each entry:
 *     u16_le(vin) + compactSize(script_len) + script + compactSize(witness_len) + witness
 *
 * Uses Bitcoin CompactSize encoding for internal length fields.
 */
export class IntrospectorPacket implements ExtensionPacket {
    private constructor(public readonly entries: IntrospectorEntry[]) {}

    static create(entries: IntrospectorEntry[]): IntrospectorPacket {
        // Validate no duplicate vins
        const seen = new Set<number>();
        for (const entry of entries) {
            if (seen.has(entry.vin)) {
                throw new Error(`duplicate vin ${entry.vin}`);
            }
            seen.add(entry.vin);
        }
        return new IntrospectorPacket(entries);
    }

    static fromBytes(data: Uint8Array): IntrospectorPacket {
        const reader = new CompactSizeReader(data);

        const entryCount = reader.readCompactSize();
        const entries: IntrospectorEntry[] = [];

        for (let i = 0; i < entryCount; i++) {
            const vin = reader.readUint16LE();
            const script = reader.readCompactSlice();
            const witness = reader.readCompactSlice();
            entries.push({ vin, script, witness });
        }

        if (reader.remaining() > 0) {
            throw new Error(`unexpected ${reader.remaining()} trailing bytes`);
        }

        return IntrospectorPacket.create(entries);
    }

    type(): number {
        return INTROSPECTOR_PACKET_TYPE;
    }

    serialize(): Uint8Array {
        const writer = new CompactSizeWriter();

        writer.writeCompactSize(this.entries.length);

        for (const entry of this.entries) {
            writer.writeUint16LE(entry.vin);
            writer.writeCompactSlice(entry.script);
            writer.writeCompactSlice(entry.witness);
        }

        return writer.toBytes();
    }
}

/**
 * CompactSizeWriter wraps BufferWriter with Bitcoin CompactSize varint support.
 */
class CompactSizeWriter {
    private buf = new BufferWriter();

    writeCompactSize(value: number): void {
        if (value < 0xfd) {
            this.buf.writeByte(value);
        } else if (value <= 0xffff) {
            this.buf.writeByte(0xfd);
            this.buf.writeUint16LE(value);
        } else if (value <= 0xffffffff) {
            this.buf.writeByte(0xfe);
            const b = new Uint8Array(4);
            new DataView(b.buffer).setUint32(0, value, true);
            this.buf.write(b);
        } else {
            throw new Error("CompactSize value too large");
        }
    }

    writeUint16LE(value: number): void {
        this.buf.writeUint16LE(value);
    }

    writeCompactSlice(data: Uint8Array): void {
        this.writeCompactSize(data.length);
        this.buf.write(data);
    }

    toBytes(): Uint8Array {
        return this.buf.toBytes();
    }
}

/**
 * CompactSizeReader wraps BufferReader with Bitcoin CompactSize varint support.
 */
class CompactSizeReader {
    private reader: BufferReader;

    constructor(data: Uint8Array) {
        this.reader = new BufferReader(data);
    }

    readCompactSize(): number {
        const first = this.reader.readByte();
        if (first < 0xfd) return first;
        if (first === 0xfd) return this.reader.readUint16LE();
        if (first === 0xfe) {
            const b = this.reader.readSlice(4);
            return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(
                0,
                true
            );
        }
        throw new Error("CompactSize 8-byte values not supported");
    }

    readUint16LE(): number {
        return this.reader.readUint16LE();
    }

    readCompactSlice(): Uint8Array {
        const length = this.readCompactSize();
        return this.reader.readSlice(length);
    }

    remaining(): number {
        return this.reader.remaining();
    }
}
