import { base58 } from "@scure/base";

export class ArkNote {
    static readonly HRP = "arknote";
    static readonly PreimageLength = 32; // 32 bytes for the preimage
    static readonly ValueLength = 4; // 4 bytes for the value
    static readonly Length = ArkNote.PreimageLength + ArkNote.ValueLength;

    constructor(
        public preimage: Uint8Array,
        public value: number
    ) {}

    encode(): Uint8Array {
        const result = new Uint8Array(ArkNote.Length);
        result.set(this.preimage, 0);
        writeUInt32BE(result, this.value, this.preimage.length);
        return result;
    }

    static decode(data: Uint8Array): ArkNote {
        if (data.length !== ArkNote.Length) {
            throw new Error(
                `invalid data length: expected ${ArkNote.Length} bytes, got ${data.length}`
            );
        }

        const preimage = data.subarray(0, ArkNote.PreimageLength);
        const value = readUInt32BE(data, ArkNote.PreimageLength);

        return new ArkNote(preimage, value);
    }

    static fromString(noteStr: string): ArkNote {
        if (!noteStr.startsWith(ArkNote.HRP)) {
            throw new Error(
                `invalid human-readable part: expected ${ArkNote.HRP} prefix (note '${noteStr}')`
            );
        }

        const encoded = noteStr.slice(ArkNote.HRP.length);

        const decoded = base58.decode(encoded);
        if (decoded.length === 0) {
            throw new Error("failed to decode base58 string");
        }

        return ArkNote.decode(new Uint8Array(decoded));
    }

    toString(): string {
        return ArkNote.HRP + base58.encode(this.encode());
    }
}

function writeUInt32BE(array: Uint8Array, value: number, offset: number): void {
    const view = new DataView(array.buffer, array.byteOffset + offset, 4);
    view.setUint32(0, value, false);
}

function readUInt32BE(array: Uint8Array, offset: number): number {
    const view = new DataView(array.buffer, array.byteOffset + offset, 4);
    return view.getUint32(0, false);
}
