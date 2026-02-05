import { hex } from "@scure/base";
import { AssetType, assetTypeToString } from "./types";
import {
    BufferReader,
    BufferWriter,
    serializeUint16,
    serializeVarUint,
} from "./utils";

export class AssetOutput {
    readonly type: AssetType;
    readonly vout: number;
    readonly amount: bigint;

    private constructor(type: AssetType, vout: number, amount: bigint) {
        this.type = type;
        this.vout = vout;
        this.amount = amount;
    }

    static create(vout: number, amount: bigint | number): AssetOutput {
        const output = new AssetOutput(
            AssetType.Local,
            vout & 0xffff,
            typeof amount === "number" ? BigInt(amount) : amount
        );
        output.validate();
        return output;
    }

    static fromString(s: string): AssetOutput {
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid asset output format, must be hex");
        }
        return AssetOutput.fromBytes(buf);
    }

    static fromBytes(buf: Uint8Array): AssetOutput {
        if (!buf || buf.length === 0) {
            throw new Error("missing asset output");
        }
        const reader = new BufferReader(buf);
        return AssetOutput.fromReader(reader);
    }

    serialize(): Uint8Array {
        const writer = new BufferWriter();
        this.serializeTo(writer);
        return writer.toBytes();
    }

    toString(): string {
        return hex.encode(this.serialize());
    }

    get typeString(): string {
        return assetTypeToString(this.type);
    }

    validate(): void {
        switch (this.type) {
            case AssetType.Local:
                break;
            case AssetType.Intent:
                throw new Error(`asset output type not supported ${this.type}`);
            case AssetType.Unspecified:
                throw new Error("asset output type unspecified");
            default:
                throw new Error(`asset output type unknown ${this.type}`);
        }
    }

    static fromReader(reader: BufferReader): AssetOutput {
        const type = reader.readByte() as AssetType;

        let output: AssetOutput;
        switch (type) {
            case AssetType.Local: {
                if (reader.remaining() < 2) {
                    throw new Error("invalid asset output vout length");
                }
                const vout = reader.readUint16LE();
                const amount = reader.readVarUint();
                output = new AssetOutput(type, vout, amount);
                break;
            }
            case AssetType.Intent:
                throw new Error(`asset output type not supported ${type}`);
            case AssetType.Unspecified:
                throw new Error("asset output type unspecified");
            default:
                throw new Error(`asset output type unknown ${type}`);
        }

        output.validate();
        return output;
    }

    serializeTo(writer: BufferWriter): void {
        writer.writeByte(this.type);

        switch (this.type) {
            case AssetType.Local:
                writer.write(serializeUint16(this.vout));
                writer.write(serializeVarUint(this.amount));
                break;
            case AssetType.Intent:
                throw new Error(`asset output type not supported ${this.type}`);
            case AssetType.Unspecified:
                throw new Error("asset output type unspecified");
            default:
                throw new Error(`asset output type unknown ${this.type}`);
        }
    }
}

export class AssetOutputs {
    readonly outputs: AssetOutput[];

    private constructor(outputs: AssetOutput[]) {
        this.outputs = outputs;
    }

    static create(outputs: AssetOutput[]): AssetOutputs {
        const list = new AssetOutputs(outputs);
        list.validate();
        return list;
    }

    static fromString(s: string): AssetOutputs {
        if (!s || s.length === 0) {
            throw new Error("missing asset outputs");
        }
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid asset outputs format, must be hex");
        }
        const reader = new BufferReader(buf);
        return AssetOutputs.fromReader(reader);
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
        const seen = new Set<number>();
        let outputType: AssetType = AssetType.Unspecified;

        for (const output of this.outputs) {
            if (seen.has(output.vout)) {
                throw new Error(`duplicated output vout ${output.vout}`);
            }
            seen.add(output.vout);

            if (outputType === AssetType.Unspecified) {
                outputType = output.type;
            }
            if (output.type !== outputType) {
                throw new Error("all outputs must be of the same type");
            }
        }
    }

    static fromReader(reader: BufferReader): AssetOutputs {
        const count = Number(reader.readVarUint());
        if (count === 0) {
            return new AssetOutputs([]);
        }

        const outputs: AssetOutput[] = [];
        for (let i = 0; i < count; i++) {
            outputs.push(AssetOutput.fromReader(reader));
        }
        return new AssetOutputs(outputs);
    }

    serializeTo(writer: BufferWriter): void {
        this.validate();
        writer.write(serializeVarUint(this.outputs.length));
        for (const output of this.outputs) {
            output.serializeTo(writer);
        }
    }
}
