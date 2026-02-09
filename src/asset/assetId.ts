import { hex } from "@scure/base";
import { TX_HASH_SIZE, ASSET_ID_SIZE } from "./types";
import { BufferReader, BufferWriter, isZeroBytes } from "./utils";

export class AssetId {
    readonly txid: Uint8Array;
    readonly index: number;

    private constructor(txid: Uint8Array, index: number) {
        this.txid = txid;
        this.index = index;
    }

    static create(txid: string, index: number): AssetId {
        if (!txid || txid.length === 0) {
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
                `invalid txid length, got ${txid.length} want ${TX_HASH_SIZE}`
            );
        }

        const assetId = new AssetId(new Uint8Array(buf), index & 0xffff);
        assetId.validate();
        return assetId;
    }

    static fromString(s: string): AssetId {
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid asset id format, must be hex");
        }
        return AssetId.fromBytes(buf);
    }

    static fromBytes(buf: Uint8Array): AssetId {
        if (!buf || buf.length === 0) {
            throw new Error("missing asset id");
        }
        const reader = new BufferReader(buf);
        return AssetId.fromReader(reader);
    }

    serialize(): Uint8Array {
        const writer = new BufferWriter();
        this.serializeTo(writer);
        return writer.toBytes();
    }

    toString(): string {
        return hex.encode(this.serialize());
    }

    get txidString(): string {
        return hex.encode(this.txid);
    }

    validate(): void {
        if (isZeroBytes(this.txid)) {
            throw new Error("empty txid");
        }
    }

    static fromReader(reader: BufferReader): AssetId {
        if (reader.remaining() < ASSET_ID_SIZE) {
            throw new Error(
                `invalid asset id length: got ${reader.remaining()}, want ${ASSET_ID_SIZE}`
            );
        }

        const txid = reader.readSlice(TX_HASH_SIZE);
        const index = reader.readUint16LE();

        const assetId = new AssetId(new Uint8Array(txid), index);
        assetId.validate();
        return assetId;
    }

    serializeTo(writer: BufferWriter): void {
        writer.write(this.txid);
        writer.writeUint16LE(this.index);
    }
}
