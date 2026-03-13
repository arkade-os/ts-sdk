import { BufferReader, BufferWriter } from "../utils";
import type { ExtensionPacket } from "../packet";

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
    witness?: Uint8Array;
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
    /** PACKET_TYPE is the 1-byte TLV type tag used in the Extension envelope. */
    static readonly PACKET_TYPE = 1;

    private constructor(public readonly entries: IntrospectorEntry[]) {}

    static create(entries: IntrospectorEntry[]): IntrospectorPacket {
        if (entries.length === 0) {
            throw new Error("empty introspector packet");
        }
        for (const entry of entries) {
            if (entry.script.length === 0) {
                throw new Error(`empty script for vin ${entry.vin}`);
            }
        }
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
        const reader = new BufferReader(data);

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
        return IntrospectorPacket.PACKET_TYPE;
    }

    serialize(): Uint8Array {
        const writer = new BufferWriter();

        writer.writeCompactSize(this.entries.length);

        for (const entry of this.entries) {
            writer.writeUint16LE(entry.vin);
            writer.writeCompactSlice(entry.script);
            writer.writeCompactSlice(entry.witness ?? new Uint8Array(0));
        }

        return writer.toBytes();
    }
}
