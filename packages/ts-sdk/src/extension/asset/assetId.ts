import { hex } from "@scure/base";
import { TX_HASH_SIZE, ASSET_ID_SIZE } from "./types";
import { BufferReader, BufferWriter, isZeroBytes } from "./utils";

/**
 * AssetId identifies a specific asset.
 *
 * @remarks
 * Asset ids are derived from the genesis transaction id plus the asset group index.
 *
 * @see AssetRef
 *
 * @example
 * ```typescript
 * const assetId = AssetId.create('00'.repeat(32), 0)
 * const encoded = assetId.toString()
 * const decoded = AssetId.fromString(encoded)
 * ```
 */
export class AssetId {
    private constructor(
        readonly txid: Uint8Array,
        readonly groupIndex: number
    ) {}

    /**
     * Create an asset id from a genesis transaction id and group index.
     *
     * @param txid - Hex-encoded genesis transaction id
     * @param groupIndex - Asset group index within the genesis transaction
     * @returns A validated asset id
     * @throws Error if the txid is missing, malformed, or not 32 bytes long
     * @see fromString
     */
    static create(txid: string, groupIndex: number): AssetId {
        if (!txid) {
            throw new Error("missing txid");
        }

        let buf: Uint8Array;
        try {
            buf = hex.decode(txid);
        } catch {
            throw new Error("invalid txid format, must be hex");
        }

        if (buf.length !== TX_HASH_SIZE) {
            throw new Error(
                `invalid txid length: got ${buf.length} bytes, want ${TX_HASH_SIZE} bytes`
            );
        }

        const assetId = new AssetId(buf, groupIndex);
        assetId.validate();
        return assetId;
    }

    /**
     * Decode an asset id from its hex string representation.
     *
     * @param s - Hex-encoded asset id
     * @returns Decoded asset id
     * @throws Error if the string is not valid hex or does not encode a valid asset id
     * @see toString
     */
    static fromString(s: string): AssetId {
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid asset id format, must be hex");
        }
        return AssetId.fromBytes(buf);
    }

    /**
     * Decode an asset id from its serialized bytes.
     *
     * @param buf - Serialized asset id bytes
     * @returns Decoded asset id
     * @throws Error if the buffer length is invalid
     */
    static fromBytes(buf: Uint8Array): AssetId {
        if (!buf || buf.length === 0) {
            throw new Error("missing asset id");
        }
        if (buf.length !== ASSET_ID_SIZE) {
            throw new Error(
                `invalid asset id length: got ${buf.length} bytes, want ${ASSET_ID_SIZE} bytes`
            );
        }
        const reader = new BufferReader(buf);
        return AssetId.fromReader(reader);
    }

    /**
     * Serialize the asset id to raw bytes.
     *
     * @returns Serialized asset id bytes
     * @see fromBytes
     */
    serialize(): Uint8Array {
        const writer = new BufferWriter();
        this.serializeTo(writer);
        return writer.toBytes();
    }

    /**
     * Encode the asset id to a hex string.
     *
     * @returns Hex-encoded asset id
     * @see fromString
     */
    toString(): string {
        return hex.encode(this.serialize());
    }

    /**
     * Validate the asset id fields.
     *
     * @throws Error if the txid is empty or the group index is out of range
     */
    validate(): void {
        if (isZeroBytes(this.txid)) {
            throw new Error("empty txid");
        }
        if (
            !Number.isInteger(this.groupIndex) ||
            this.groupIndex < 0 ||
            this.groupIndex > 0xffff
        ) {
            throw new Error(
                `invalid group index: ${this.groupIndex}, must be in range [0, 65535]`
            );
        }
    }

    /**
     * Decode an asset id from a binary reader.
     *
     * @param reader - Reader positioned at an asset id
     * @returns Decoded asset id
     * @throws Error if the reader does not contain enough bytes
     */
    static fromReader(reader: BufferReader): AssetId {
        if (reader.remaining() < ASSET_ID_SIZE) {
            throw new Error(
                `invalid asset id length: got ${reader.remaining()}, want ${ASSET_ID_SIZE}`
            );
        }

        const txid = reader.readSlice(TX_HASH_SIZE);
        const index = reader.readUint16LE();

        const assetId = new AssetId(txid, index);
        assetId.validate();
        return assetId;
    }

    /**
     * Serialize the asset id into an existing binary writer.
     *
     * @param writer - Writer to append the asset id to
     * @see serialize
     */
    serializeTo(writer: BufferWriter): void {
        writer.write(this.txid);
        writer.writeUint16LE(this.groupIndex);
    }
}
