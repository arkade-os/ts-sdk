export class BufferWriter {
    private buffer: number[] = [];

    write(data: Uint8Array): void {
        for (const byte of data) {
            this.buffer.push(byte);
        }
    }

    writeByte(byte: number): void {
        this.buffer.push(byte & 0xff);
    }

    writeUint16LE(value: number): void {
        const buf = new Uint8Array(2);
        new DataView(buf.buffer).setUint16(0, value, true); // true = little endian
        this.write(buf);
    }

    writeVarUint(value: bigint | number): void {
        if (typeof value === "number") {
            if (!Number.isInteger(value) || value < 0) {
                throw new RangeError(
                    "writeVarUint: value must be a non-negative integer"
                );
            }
        } else if (value < 0n) {
            throw new RangeError(
                "writeVarUint: value must be a non-negative integer"
            );
        }
        const val = typeof value === "number" ? BigInt(value) : value;
        const bytes: number[] = [];
        let remaining = val;

        do {
            let byte = Number(remaining & 0x7fn);
            remaining >>= 7n;
            if (remaining > 0n) {
                byte |= 0x80;
            }
            bytes.push(byte);
        } while (remaining > 0n);

        this.write(new Uint8Array(bytes));
    }

    writeVarSlice(data: Uint8Array): void {
        this.writeVarUint(data.length);
        this.write(data);
    }

    toBytes(): Uint8Array {
        return new Uint8Array(this.buffer);
    }
}

export class BufferReader {
    private view: DataView;
    private offset: number = 0;

    constructor(data: Uint8Array) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }

    remaining(): number {
        return this.view.byteLength - this.offset;
    }

    readByte(): number {
        if (this.offset >= this.view.byteLength) {
            throw new Error("unexpected end of buffer");
        }
        return this.view.getUint8(this.offset++);
    }

    readSlice(size: number): Uint8Array {
        if (this.offset + size > this.view.byteLength) {
            throw new Error("unexpected end of buffer");
        }
        const result = new Uint8Array(
            this.view.buffer,
            this.view.byteOffset + this.offset,
            size
        );
        this.offset += size;
        return result;
    }

    readUint16LE(): number {
        if (this.offset + 2 > this.view.byteLength) {
            throw new Error("unexpected end of buffer");
        }
        const value = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return value;
    }

    readVarUint(): bigint {
        let result = 0n;
        let shift = 0n;
        let byte: number;

        do {
            if (this.offset >= this.view.byteLength) {
                throw new Error("unexpected end of buffer");
            }
            byte = this.view.getUint8(this.offset++);
            result |= BigInt(byte & 0x7f) << shift;
            shift += 7n;
        } while (byte & 0x80);

        return result;
    }

    readVarSlice(): Uint8Array {
        const length = Number(this.readVarUint());
        return this.readSlice(length);
    }
}

export function isZeroBytes(bytes: Uint8Array): boolean {
    return bytes.every((byte) => byte === 0);
}
