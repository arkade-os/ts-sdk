import { hex } from "@scure/base";
import { AssetInputType, TX_HASH_SIZE } from "./types";
import { BufferReader, BufferWriter, isZeroBytes } from "./utils";

type AssetInputLocal = {
    type: AssetInputType.Local;
    vin: number;
    amount: bigint;
};

type AssetInputIntent = Pick<AssetInputLocal, "vin" | "amount"> & {
    type: AssetInputType.Intent;
    txid: Uint8Array;
};

/**
 * AssetInput represents an input of an asset group.
 * a local input references a real transaction input and specify the amount in satoshis.
 * an intent input references an external intent transaction. It is created by the server to handle batch leaf transaction.
 */
export class AssetInput {
    private constructor(readonly input: AssetInputLocal | AssetInputIntent) {}

    get vin(): number {
        return this.input.vin;
    }
    get amount(): bigint {
        return this.input.amount;
    }

    static create(vin: number, amount: bigint | number): AssetInput {
        const input = new AssetInput({
            type: AssetInputType.Local,
            vin,
            amount: typeof amount === "number" ? BigInt(amount) : amount,
        });
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

        const input = new AssetInput({
            type: AssetInputType.Intent,
            txid: buf,
            vin,
            amount: typeof amount === "number" ? BigInt(amount) : amount,
        });
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

    validate(): void {
        switch (this.input.type) {
            case AssetInputType.Local:
                break;
            case AssetInputType.Intent:
                if (isZeroBytes(this.input.txid)) {
                    throw new Error("missing input intent txid");
                }
                break;
        }
    }

    static fromReader(reader: BufferReader): AssetInput {
        const type = reader.readByte() as AssetInputType;

        let input: AssetInput;
        switch (type) {
            case AssetInputType.Local: {
                const vin = reader.readUint16LE();
                const amount = reader.readVarUint();
                input = new AssetInput({
                    type: AssetInputType.Local,
                    vin,
                    amount,
                });
                break;
            }
            case AssetInputType.Intent: {
                if (reader.remaining() < TX_HASH_SIZE) {
                    throw new Error("invalid input intent txid length");
                }
                const txid = reader.readSlice(TX_HASH_SIZE);
                const vin = reader.readUint16LE();
                const amount = reader.readVarUint();
                input = new AssetInput({
                    type: AssetInputType.Intent,
                    txid: new Uint8Array(txid),
                    vin,
                    amount,
                });
                break;
            }
            case AssetInputType.Unspecified:
                throw new Error("asset input type unspecified");
            default:
                throw new Error(`asset input type ${type} unknown`);
        }

        input.validate();
        return input;
    }

    serializeTo(writer: BufferWriter): void {
        writer.writeByte(this.input.type);
        if (this.input.type === AssetInputType.Intent) {
            writer.write(this.input.txid);
        }
        writer.writeUint16LE(this.input.vin);
        writer.writeVarUint(this.input.amount);
    }
}

/**
 * AssetInputs represents a list of asset inputs.
 */
export class AssetInputs {
    private constructor(readonly inputs: AssetInput[]) {}

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
        let listType = AssetInputType.Unspecified;

        for (const assetInput of this.inputs) {
            assetInput.validate();

            if (listType === AssetInputType.Unspecified) {
                listType = assetInput.input.type;
            } else if (listType !== assetInput.input.type) {
                throw new Error("all inputs must be of the same type");
            }

            // verify the same input vin is not duplicated
            if (assetInput.input.type === AssetInputType.Local) {
                if (seen.has(assetInput.input.vin)) {
                    throw new Error(
                        `duplicated input vin ${assetInput.input.vin}`
                    );
                }
                seen.add(assetInput.input.vin);
                continue;
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
        writer.writeVarUint(this.inputs.length);
        for (const input of this.inputs) {
            input.serializeTo(writer);
        }
    }
}
