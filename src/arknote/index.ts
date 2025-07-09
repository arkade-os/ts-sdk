import { base58, hex } from "@scure/base";
import { TapLeafScript, VtxoScript } from "../script/base";
import { Bytes, sha256 } from "@scure/btc-signer/utils";
import { Script } from "@scure/btc-signer";
import { ExtendedCoin, Status } from "../wallet";

/**
 * ArkNotes are special virtual coins in the Ark protocol that can be created
 * and spent without requiring any transactions. The server mints them, and they
 * are encoded as base58 strings with a human-readable prefix. It contains a
 * preimage and value.
 *
 * @example
 * ```typescript
 * // Create an ArkNote
 * const note = new ArkNote(preimage, 50000);
 *
 * // Encode to string
 * const noteString = note.toString();
 *
 * // Decode from string
 * const decodedNote = ArkNote.fromString(noteString);
 * ```
 */
export class ArkNote implements ExtendedCoin {
    static readonly DefaultHRP = "arknote";
    static readonly PreimageLength = 32; // 32 bytes for the preimage
    static readonly ValueLength = 4; // 4 bytes for the value
    static readonly Length = ArkNote.PreimageLength + ArkNote.ValueLength;
    static readonly FakeOutpointIndex = 0;

    readonly vtxoScript: VtxoScript;

    // ExtendedCoin properties
    readonly txid: string;
    readonly vout = 0;
    readonly forfeitTapLeafScript: TapLeafScript;
    readonly intentTapLeafScript: TapLeafScript;
    readonly tapTree: Bytes;
    readonly status: Status;
    readonly extraWitness?: Bytes[] | undefined;

    constructor(
        public preimage: Uint8Array,
        public value: number,
        public HRP = ArkNote.DefaultHRP
    ) {
        const preimageHash = sha256(this.preimage);
        this.vtxoScript = new VtxoScript([noteTapscript(preimageHash)]);

        const leaf = this.vtxoScript.leaves[0];

        this.txid = hex.encode(new Uint8Array(preimageHash).reverse());
        this.tapTree = this.vtxoScript.encode();
        this.forfeitTapLeafScript = leaf;
        this.intentTapLeafScript = leaf;
        this.value = value;
        this.status = { confirmed: true };
        this.extraWitness = [this.preimage];
    }

    encode(): Uint8Array {
        const result = new Uint8Array(ArkNote.Length);
        result.set(this.preimage, 0);
        writeUInt32BE(result, this.value, this.preimage.length);
        return result;
    }

    static decode(data: Uint8Array, hrp = ArkNote.DefaultHRP): ArkNote {
        if (data.length !== ArkNote.Length) {
            throw new Error(
                `invalid data length: expected ${ArkNote.Length} bytes, got ${data.length}`
            );
        }

        const preimage = data.subarray(0, ArkNote.PreimageLength);
        const value = readUInt32BE(data, ArkNote.PreimageLength);

        return new ArkNote(preimage, value, hrp);
    }

    static fromString(noteStr: string, hrp = ArkNote.DefaultHRP): ArkNote {
        noteStr = noteStr.trim();
        if (!noteStr.startsWith(hrp)) {
            throw new Error(
                `invalid human-readable part: expected ${hrp} prefix (note '${noteStr}')`
            );
        }

        const encoded = noteStr.slice(hrp.length);

        const decoded = base58.decode(encoded);
        if (decoded.length === 0) {
            throw new Error("failed to decode base58 string");
        }

        return ArkNote.decode(decoded, hrp);
    }

    toString(): string {
        return this.HRP + base58.encode(this.encode());
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

function noteTapscript(preimageHash: Uint8Array): Bytes {
    return Script.encode(["SHA256", preimageHash, "EQUAL"]);
}
