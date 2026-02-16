import { hex } from "@scure/base";
import { BufferReader, BufferWriter } from "./utils";

/**
 * AssetOutput references a real transaction output and specify the amount in satoshis.
 * it must be present in an AssetGroup.
 *
 * @param vout - the output index in the transaction
 * @param amount - asset amount in satoshis
 */
export class AssetOutput {
    // 0x01 means local output, there is only 1 local output type currently
    // however we serialize it for future upgrades
    static readonly TYPE_LOCAL = 0x01;

    private constructor(
        readonly vout: number,
        readonly amount: bigint
    ) {}

    static create(vout: number, amount: bigint | number): AssetOutput {
        const output = new AssetOutput(
            vout,
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
        const output = AssetOutput.fromReader(reader);
        output.validate();
        return output;
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
        if (
            !Number.isInteger(this.vout) ||
            this.vout < 0 ||
            this.vout > 0xffff
        ) {
            throw new Error(
                "asset output vout must be an integer in range [0, 65535]"
            );
        }
        if (this.amount <= 0n) {
            throw new Error("asset output amount must be greater than 0");
        }
    }

    static fromReader(reader: BufferReader): AssetOutput {
        if (reader.remaining() < 2) {
            throw new Error("invalid asset output vout length");
        }
        const type = reader.readByte();
        if (type !== AssetOutput.TYPE_LOCAL) {
            if (type === 0x00) {
                throw new Error("output type unspecified");
            }
            throw new Error("unknown asset output type");
        }

        let vout: number;
        try {
            vout = reader.readUint16LE();
        } catch {
            throw new Error("invalid asset output vout length");
        }

        const amount = reader.readVarUint();
        return new AssetOutput(vout, amount);
    }

    serializeTo(writer: BufferWriter): void {
        writer.writeByte(0x01);
        writer.writeUint16LE(this.vout);
        writer.writeVarUint(this.amount);
    }
}

/**
 * AssetOutputs is a list of AssetOutput references.
 * it must be present in an AssetGroup.
 *
 * @param outputs - the list of asset outputs
 */
export class AssetOutputs {
    private constructor(readonly outputs: AssetOutput[]) {}

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
        for (const output of this.outputs) {
            if (seen.has(output.vout)) {
                throw new Error(`duplicated output vout ${output.vout}`);
            }
            seen.add(output.vout);
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
        const result = new AssetOutputs(outputs);
        result.validate();
        return result;
    }

    serializeTo(writer: BufferWriter): void {
        this.validate();
        writer.writeVarUint(this.outputs.length);
        for (const output of this.outputs) {
            output.serializeTo(writer);
        }
    }
}
