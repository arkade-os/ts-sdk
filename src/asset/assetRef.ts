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

export class AssetRef {
    private constructor(readonly ref: AssetRefByID | AssetRefByGroup) {}

    get type(): AssetRefType {
        return this.ref.type;
    }

    static fromId(assetId: AssetId): AssetRef {
        return new AssetRef({ type: AssetRefType.ByID, assetId });
    }

    static fromGroupIndex(groupIndex: number): AssetRef {
        return new AssetRef({ type: AssetRefType.ByGroup, groupIndex });
    }

    static fromString(s: string): AssetRef {
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid asset ref format, must be hex");
        }
        return AssetRef.fromBytes(buf);
    }

    static fromBytes(buf: Uint8Array): AssetRef {
        if (!buf || buf.length === 0) {
            throw new Error("missing asset ref");
        }
        const reader = new BufferReader(buf);
        return AssetRef.fromReader(reader);
    }

    serialize(): Uint8Array {
        const writer = new BufferWriter();
        this.serializeTo(writer);
        return writer.toBytes();
    }

    toString(): string {
        return hex.encode(this.serialize());
    }

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
