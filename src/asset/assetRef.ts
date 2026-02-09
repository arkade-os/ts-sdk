import { hex } from "@scure/base";
import { AssetRefType } from "./types";
import { AssetId } from "./assetId";
import { BufferReader, BufferWriter } from "./utils";

export class AssetRef {
    readonly type: AssetRefType;
    readonly assetId?: AssetId;
    readonly groupIndex?: number;

    private constructor(
        type: AssetRefType,
        assetId?: AssetId,
        groupIndex?: number
    ) {
        this.type = type;
        this.assetId = assetId;
        this.groupIndex = groupIndex;
    }

    static fromId(assetId: AssetId): AssetRef {
        const ref = new AssetRef(AssetRefType.ByID, assetId, undefined);
        ref.validate();
        return ref;
    }

    static fromGroupIndex(groupIndex: number): AssetRef {
        const ref = new AssetRef(
            AssetRefType.ByGroup,
            undefined,
            groupIndex & 0xffff
        );
        ref.validate();
        return ref;
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

    validate(): void {
        switch (this.type) {
            case AssetRefType.ByID:
            case AssetRefType.ByGroup:
                break;
            case AssetRefType.Unspecified:
                throw new Error("asset ref type unspecified");
            default:
                throw new Error(`asset ref type unknown ${this.type}`);
        }
    }

    static fromReader(reader: BufferReader): AssetRef {
        const type = reader.readByte() as AssetRefType;

        let ref: AssetRef;
        switch (type) {
            case AssetRefType.ByID: {
                const assetId = AssetId.fromReader(reader);
                ref = new AssetRef(type, assetId, undefined);
                break;
            }
            case AssetRefType.ByGroup: {
                if (reader.remaining() < 2) {
                    throw new Error("invalid asset ref length");
                }
                const groupIndex = reader.readUint16LE();
                ref = new AssetRef(type, undefined, groupIndex);
                break;
            }
            case AssetRefType.Unspecified:
                throw new Error("asset ref type unspecified");
            default:
                throw new Error(`asset ref type unknown ${type}`);
        }

        ref.validate();
        return ref;
    }

    serializeTo(writer: BufferWriter): void {
        writer.writeByte(this.type);

        switch (this.type) {
            case AssetRefType.ByID:
                this.assetId!.serializeTo(writer);
                break;
            case AssetRefType.ByGroup:
                writer.writeUint16LE(this.groupIndex!);
                break;
        }
    }
}
