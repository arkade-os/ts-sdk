import { hex } from "@scure/base";
import type { ExtensionPacket } from "../packet";
import { AssetRefType } from "./types";
import { AssetGroup } from "./assetGroup";
import { BufferReader, BufferWriter } from "./utils";

/**
 * Packet represents a collection of asset groups.
 * It encodes/decodes as raw bytes only — OP_RETURN framing is handled by the Extension module.
 */
export class Packet implements ExtensionPacket {
    /** PACKET_TYPE is the 1-byte TLV type tag used in the Extension envelope. */
    static readonly PACKET_TYPE = 0;

    private constructor(readonly groups: AssetGroup[]) {}

    static create(groups: AssetGroup[]): Packet {
        const p = new Packet(groups);
        p.validate();
        return p;
    }

    /**
     * fromBytes parses a Packet from raw bytes.
     */
    static fromBytes(buf: Uint8Array): Packet {
        return Packet.fromReader(new BufferReader(buf));
    }

    /**
     * fromString parses a Packet from a raw hex string (not an OP_RETURN script).
     */
    static fromString(s: string): Packet {
        if (!s) {
            throw new Error("missing packet data");
        }
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid packet format, must be hex");
        }
        return Packet.fromBytes(buf);
    }

    /**
     * type returns the TLV packet type tag. Implements ExtensionPacket interface.
     */
    type(): number {
        return Packet.PACKET_TYPE;
    }

    leafTxPacket(intentTxid: Uint8Array): Packet {
        const leafGroups = this.groups.map((group) =>
            group.toBatchLeafAssetGroup(intentTxid)
        );
        return new Packet(leafGroups);
    }

    /**
     * serialize encodes the packet as raw bytes (varint group count + group data).
     * Does NOT include OP_RETURN, ARK magic, or TLV type/length — those are
     * added by the Extension module.
     */
    serialize(): Uint8Array {
        if (this.groups.length === 0) {
            return new Uint8Array(0);
        }
        const writer = new BufferWriter();
        writer.writeVarUint(this.groups.length);
        for (const group of this.groups) {
            group.serializeTo(writer);
        }
        return writer.toBytes();
    }

    /**
     * toString returns the hex-encoded raw packet bytes.
     */
    toString(): string {
        return hex.encode(this.serialize());
    }

    validate(): void {
        if (this.groups.length === 0) {
            throw new Error("missing assets");
        }

        const seenAssetIds = new Set<string>();
        for (const group of this.groups) {
            if (group.assetId !== null) {
                const key = group.assetId.toString();
                if (seenAssetIds.has(key)) {
                    throw new Error(`duplicate asset group for asset ${key}`);
                }
                seenAssetIds.add(key);
            }

            if (
                group.controlAsset !== null &&
                group.controlAsset.ref.type === AssetRefType.ByGroup &&
                group.controlAsset.ref.groupIndex >= this.groups.length
            ) {
                throw new Error(
                    `invalid control asset group index, ${group.controlAsset.ref.groupIndex} out of range [0, ${this.groups.length - 1}]`
                );
            }
        }
    }

    private static fromReader(reader: BufferReader): Packet {
        const count = Number(reader.readVarUint());
        const groups: AssetGroup[] = [];

        for (let i = 0; i < count; i++) {
            groups.push(AssetGroup.fromReader(reader));
        }

        if (reader.remaining() > 0) {
            throw new Error(
                `invalid packet length, left ${reader.remaining()} unknown bytes to read`
            );
        }

        const packet = new Packet(groups);
        packet.validate();
        return packet;
    }
}
