import { hex } from "@scure/base";
import { AssetType, TX_HASH_SIZE, assetTypeToString } from "./types";
import {
    BufferReader,
    BufferWriter,
    isZeroBytes,
    serializeUint16,
    serializeVarUint,
} from "./utils";

export class AssetInput {
    readonly type: AssetType;
    readonly vin: number;
    readonly txid: Uint8Array;
    readonly amount: bigint;

    private constructor(
        type: AssetType,
        vin: number,
        amount: bigint,
        txid?: Uint8Array
    ) {
        this.type = type;
        this.vin = vin;
        this.amount = amount;
        this.txid = txid || new Uint8Array(TX_HASH_SIZE);
    }

    static create(vin: number, amount: bigint | number): AssetInput {
        const input = new AssetInput(
            AssetType.Local,
            vin & 0xffff,
            typeof amount === "number" ? BigInt(amount) : amount
        );
        input.validate();
        return input;
    }

    static createIntent(
        txid: string,
        vin: number,
        amount: bigint | number
    ): AssetInput {
        if (!txid || txid.length === 0) {
            throw new Error("missing input intent txid");
        }

        let buf: Uint8Array;
        try {
            buf = hex.decode(txid);
        } catch {
            throw new Error("invalid input intent txid format, must be hex");
        }

        if (buf.length !== TX_HASH_SIZE) {
            throw new Error("invalid input intent txid length");
        }

        const input = new AssetInput(
            AssetType.Intent,
            vin & 0xffff,
            typeof amount === "number" ? BigInt(amount) : amount,
            buf
        );
        input.validate();
        return input;
    }

    static fromString(s: string): AssetInput {
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid format, must be hex");
        }
        return AssetInput.fromBytes(buf);
    }

    static fromBytes(buf: Uint8Array): AssetInput {
        const reader = new BufferReader(buf);
        return AssetInput.fromReader(reader);
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
                if (isZeroBytes(this.txid)) {
                    throw new Error("missing input intent txid");
                }
                break;
            case AssetType.Unspecified:
                throw new Error("asset input type unspecified");
            default:
                throw new Error(`asset input type ${this.type} unknown`);
        }
    }

    static fromReader(reader: BufferReader): AssetInput {
        const type = reader.readByte() as AssetType;

        let input: AssetInput;
        switch (type) {
            case AssetType.Local: {
                const vin = reader.readUint16LE();
                const amount = reader.readVarUint();
                input = new AssetInput(type, vin, amount);
                break;
            }
            case AssetType.Intent: {
                if (reader.remaining() < TX_HASH_SIZE) {
                    throw new Error("invalid input intent txid length");
                }
                const txid = reader.readSlice(TX_HASH_SIZE);
                const vin = reader.readUint16LE();
                const amount = reader.readVarUint();
                input = new AssetInput(type, vin, amount, new Uint8Array(txid));
                break;
            }
            case AssetType.Unspecified:
                throw new Error("asset input type unspecified");
            default:
                throw new Error(`asset input type ${type} unknown`);
        }

        input.validate();
        return input;
    }

    serializeTo(writer: BufferWriter): void {
        writer.writeByte(this.type);

        switch (this.type) {
            case AssetType.Local:
                writer.write(serializeUint16(this.vin));
                writer.write(serializeVarUint(this.amount));
                break;
            case AssetType.Intent:
                writer.write(this.txid);
                writer.write(serializeUint16(this.vin));
                writer.write(serializeVarUint(this.amount));
                break;
            case AssetType.Unspecified:
                throw new Error("asset input type unspecified");
            default:
                throw new Error(`asset input type ${this.type} unknown`);
        }
    }
}

export class AssetInputs {
    readonly inputs: AssetInput[];

    private constructor(inputs: AssetInput[]) {
        this.inputs = inputs;
    }

    static create(inputs: AssetInput[]): AssetInputs {
        const list = new AssetInputs(inputs);
        list.validate();
        return list;
    }

    static fromString(s: string): AssetInputs {
        if (!s || s.length === 0) {
            throw new Error("missing asset inputs");
        }
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid asset inputs format, must be hex");
        }
        const reader = new BufferReader(buf);
        return AssetInputs.fromReader(reader);
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
        let inputType: AssetType = AssetType.Unspecified;

        for (const input of this.inputs) {
            if (seen.has(input.vin)) {
                throw new Error(`duplicated input vin ${input.vin}`);
            }
            seen.add(input.vin);

            if (inputType === AssetType.Unspecified) {
                inputType = input.type;
            }
            if (input.type !== inputType) {
                throw new Error("all inputs must be of the same type");
            }
        }
    }

    static fromReader(reader: BufferReader): AssetInputs {
        const count = Number(reader.readVarUint());
        if (count === 0) {
            return new AssetInputs([]);
        }

        const inputs: AssetInput[] = [];
        for (let i = 0; i < count; i++) {
            inputs.push(AssetInput.fromReader(reader));
        }
        return new AssetInputs(inputs);
    }

    serializeTo(writer: BufferWriter): void {
        writer.write(serializeVarUint(this.inputs.length));
        for (const input of this.inputs) {
            input.serializeTo(writer);
        }
    }
}
