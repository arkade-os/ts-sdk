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

    validate(): void {
        if (this.vout < 0) {
            throw new Error("asset output vout must be non-negative");
        }
        if (this.amount <= 0n) {
            throw new Error("asset output amount must be greater than 0");
        }
    }

    static fromReader(reader: BufferReader): AssetOutput {
        if (reader.remaining() < 2) {
            throw new Error("invalid asset output vout length");
        }
        const vout = reader.readUint16LE();
        const amount = reader.readVarUint();
        const output = new AssetOutput(vout, amount);
        output.validate();
        return output;
    }

    serializeTo(writer: BufferWriter): void {
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
        return new AssetOutputs(outputs);
    }

    serializeTo(writer: BufferWriter): void {
        this.validate();
        writer.writeVarUint(this.outputs.length);
        for (const output of this.outputs) {
            output.serializeTo(writer);
        }
    }
}
