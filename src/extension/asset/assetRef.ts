import { hex } from "@scure/base";
import { AssetRefType } from "./types";
import { AssetId } from "./assetId";
import { BufferReader, BufferWriter } from "./utils";

type AssetRefByID = {
    type: AssetRefType.ByID;
    assetId: AssetId;
};
type AssetRefByGroup = {
    type: AssetRefType.ByGroup;
    groupIndex: number;
};

/**
 * Reference to either an explicit asset id or another asset group in the same packet.
 *
 * @see AssetId
 *
 * @example
 * ```typescript
 * const refById = AssetRef.fromId(assetId)
 * const refByGroup = AssetRef.fromGroupIndex(0)
 * ```
 */
export class AssetRef {
    private constructor(readonly ref: AssetRefByID | AssetRefByGroup) {}

    /** Reference type discriminator. */
    get type(): AssetRefType {
        return this.ref.type;
    }

    /**
     * Create an asset reference that points to a specific asset id.
     *
     * @param assetId - Asset id referenced by this pointer
     * @returns Asset reference by id
     * @see fromGroupIndex
     */
    static fromId(assetId: AssetId): AssetRef {
        return new AssetRef({ type: AssetRefType.ByID, assetId });
    }

    /**
     * Create an asset reference that points to another asset group by index.
     *
     * @param groupIndex - Zero-based asset group index in the packet
     * @returns Asset reference by group index
     * @see fromId
     */
    static fromGroupIndex(groupIndex: number): AssetRef {
        return new AssetRef({ type: AssetRefType.ByGroup, groupIndex });
    }

    /**
     * Decode an asset reference from its hex string form.
     *
     * @param s - Hex-encoded asset reference
     * @returns Decoded asset reference
     * @throws Error if the string is not valid hex or does not encode a valid asset reference
     * @see toString
     */
    static fromString(s: string): AssetRef {
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid asset ref format, must be hex");
        }
        return AssetRef.fromBytes(buf);
    }

    /**
     * Decode an asset reference from its serialized bytes.
     *
     * @param buf - Serialized asset reference bytes
     * @returns Decoded asset reference
     * @throws Error if the buffer is empty or malformed
     */
    static fromBytes(buf: Uint8Array): AssetRef {
        if (!buf || buf.length === 0) {
            throw new Error("missing asset ref");
        }
        const reader = new BufferReader(buf);
        return AssetRef.fromReader(reader);
    }

    /**
     * Serialize the asset reference to raw bytes.
     *
     * @returns Serialized asset reference bytes
     * @see fromBytes
     */
    serialize(): Uint8Array {
        const writer = new BufferWriter();
        this.serializeTo(writer);
        return writer.toBytes();
    }

    /**
     * Encode the asset reference to a hex string.
     *
     * @returns Hex-encoded asset reference
     * @see fromString
     */
    toString(): string {
        return hex.encode(this.serialize());
    }

    /**
     * Decode an asset reference from a binary reader.
     *
     * @param reader - Reader positioned at an asset reference
     * @returns Decoded asset reference
     * @throws Error if the type is unknown or the reader does not contain enough bytes
     */
    static fromReader(reader: BufferReader): AssetRef {
        const type = reader.readByte() as AssetRefType;

        let ref: AssetRef;
        switch (type) {
            case AssetRefType.ByID: {
                const assetId = AssetId.fromReader(reader);
                ref = new AssetRef({ type: AssetRefType.ByID, assetId });
                break;
            }
            case AssetRefType.ByGroup: {
                if (reader.remaining() < 2) {
                    throw new Error("invalid asset ref length");
                }
                const groupIndex = reader.readUint16LE();
                ref = new AssetRef({ type: AssetRefType.ByGroup, groupIndex });
                break;
            }
            case AssetRefType.Unspecified:
                throw new Error("asset ref type unspecified");
            default:
                throw new Error(`asset ref type unknown ${type}`);
        }

        return ref;
    }

    /**
     * Serialize the asset reference into an existing binary writer.
     *
     * @param writer - Writer to append the asset reference to
     * @see serialize
     */
    serializeTo(writer: BufferWriter): void {
        writer.writeByte(this.ref.type);

        switch (this.ref.type) {
            case AssetRefType.ByID:
                this.ref.assetId.serializeTo(writer);
                break;
            case AssetRefType.ByGroup:
                writer.writeUint16LE(this.ref.groupIndex);
                break;
        }
    }
}
