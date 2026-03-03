import { hex } from "@scure/base";
import { Script } from "@scure/btc-signer";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { Packet } from "./asset/packet";
import { BufferReader } from "./asset/utils";
import { ExtensionPacket, UnknownPacket } from "./packet";
import type { TransactionOutput } from "@scure/btc-signer/psbt";
import type { Transaction } from "../utils/transaction";

export type { ExtensionPacket } from "./packet";
export { UnknownPacket } from "./packet";

/**
 * ArkadeMagic is the 3-byte magic prefix ("ARK") that identifies an OP_RETURN
 * output as an ark extension blob.
 */
export const ARKADE_MAGIC = new Uint8Array([0x41, 0x52, 0x4b]); // "ARK"

/**
 * ErrExtensionNotFound is thrown when no extension output is found in a transaction.
 */
export class ExtensionNotFoundError extends Error {
    constructor() {
        super("no extension output found in transaction");
        this.name = "ExtensionNotFoundError";
    }
}

/**
 * Extension is a set of typed packets encoded in an OP_RETURN output.
 *
 * Wire format:
 *   OP_RETURN | <push> | ARK(3B) | [type(1B) | varint_len | data]...
 */
export class Extension {
    private constructor(private readonly packets: ExtensionPacket[]) {}

    static create(packets: ExtensionPacket[]): Extension {
        if (packets.length === 0) {
            throw new Error("missing packets");
        }
        const seen = new Set<number>();
        for (const p of packets) {
            if (seen.has(p.type())) {
                throw new Error(`duplicate packet type ${p.type()}`);
            }
            seen.add(p.type());
        }
        return new Extension(packets);
    }

    /**
     * isExtension returns true if the script is an OP_RETURN whose push data
     * begins with the ARK magic bytes.
     */
    static isExtension(script: Uint8Array): boolean {
        try {
            const decoded = Script.decode(script);
            if (decoded.length < 2 || decoded[0] !== "RETURN") return false;
            const data = decoded[1];
            if (!(data instanceof Uint8Array)) return false;
            return (
                data.length >= ARKADE_MAGIC.length &&
                equalBytes(data.slice(0, ARKADE_MAGIC.length), ARKADE_MAGIC)
            );
        } catch {
            return false;
        }
    }

    /**
     * fromBytes parses an Extension from a raw OP_RETURN script.
     */
    static fromBytes(script: Uint8Array): Extension {
        if (!script || script.length === 0) {
            throw new Error("missing OP_RETURN");
        }

        let decoded: ReturnType<typeof Script.decode>;
        try {
            decoded = Script.decode(script);
        } catch {
            throw new Error("expected OP_RETURN");
        }

        if (decoded.length === 0 || decoded[0] !== "RETURN") {
            throw new Error("expected OP_RETURN");
        }

        const dataPushes = decoded
            .slice(1)
            .filter((x): x is Uint8Array => x instanceof Uint8Array);
        if (dataPushes.length === 0) {
            throw new Error("missing magic prefix: EOF");
        }

        // Concatenate all data pushes (handles OP_PUSHDATA1/2/4)
        const payload = new Uint8Array(
            dataPushes.reduce((acc, d) => acc + d.length, 0)
        );
        let offset = 0;
        for (const d of dataPushes) {
            payload.set(d, offset);
            offset += d.length;
        }

        // Check ARK magic
        if (
            payload.length < ARKADE_MAGIC.length ||
            !equalBytes(payload.slice(0, ARKADE_MAGIC.length), ARKADE_MAGIC)
        ) {
            throw new Error(
                `expected magic prefix ${hex.encode(ARKADE_MAGIC)}, got ${hex.encode(payload.slice(0, Math.min(payload.length, ARKADE_MAGIC.length)))}`
            );
        }

        // Parse TLV records
        const reader = new BufferReader(payload.slice(ARKADE_MAGIC.length));
        const packets: ExtensionPacket[] = [];

        while (reader.remaining() > 0) {
            const packetType = reader.readByte();
            let data: Uint8Array;
            try {
                data = reader.readVarSlice();
            } catch {
                throw new Error("missing packet data");
            }
            packets.push(parsePacket(packetType, data));
        }

        if (packets.length === 0) {
            throw new Error("missing packets");
        }

        // Reject duplicate packet types
        const seen = new Set<number>();
        for (const p of packets) {
            if (seen.has(p.type())) {
                throw new Error(`duplicate packet type ${p.type()}`);
            }
            seen.add(p.type());
        }

        return new Extension(packets);
    }

    /**
     * fromTx searches the transaction outputs for an extension blob and parses it.
     * Throws ExtensionNotFoundError if none is found.
     */
    static fromTx(tx: Transaction): Extension {
        for (let i = 0; i < tx.outputsLength; i++) {
            const output = tx.getOutput(i);
            if (!output?.script) continue;
            if (Extension.isExtension(output.script)) {
                return Extension.fromBytes(output.script);
            }
        }
        throw new ExtensionNotFoundError();
    }

    /**
     * serialize encodes the extension as an OP_RETURN script.
     *
     * Layout: OP_RETURN | <push> | ARK | [type | varint_len | data]...
     */
    serialize(): Uint8Array {
        // Build payload: ARK magic + TLV records
        const parts: Uint8Array[] = [ARKADE_MAGIC];

        for (const p of this.packets) {
            const data = p.serialize();
            // type (1 byte)
            const typeByte = new Uint8Array([p.type()]);
            // varint length prefix + data
            const lengthBuf = encodeVarUint(data.length);
            parts.push(typeByte, lengthBuf, data);
        }

        const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
        const payload = new Uint8Array(totalLen);
        let off = 0;
        for (const p of parts) {
            payload.set(p, off);
            off += p.length;
        }

        return buildOpReturnScript(payload);
    }

    /**
     * txOut returns the extension as a zero-value OP_RETURN transaction output.
     */
    txOut(): Required<Pick<TransactionOutput, "script" | "amount">> {
        return {
            script: this.serialize(),
            amount: 0n,
        };
    }

    /**
     * getAssetPacket returns the embedded Packet, or null if not present.
     */
    getAssetPacket(): Packet | null {
        for (const p of this.packets) {
            if (p instanceof Packet) {
                return p;
            }
        }
        return null;
    }
}

/**
 * parsePacket dispatches to a known packet type or falls back to UnknownPacket.
 */
function parsePacket(packetType: number, data: Uint8Array): ExtensionPacket {
    if (packetType === Packet.PACKET_TYPE) {
        return Packet.fromBytes(data);
    }
    return new UnknownPacket(packetType, data);
}

/**
 * encodeVarUint encodes a non-negative integer as a LEB128 unsigned varint.
 */
function encodeVarUint(value: number): Uint8Array {
    const bytes: number[] = [];
    let remaining = value;
    do {
        let byte = remaining & 0x7f;
        remaining >>>= 7;
        if (remaining > 0) byte |= 0x80;
        bytes.push(byte);
    } while (remaining > 0);
    return new Uint8Array(bytes);
}

/**
 * buildOpReturnScript builds an OP_RETURN script with an arbitrary-length data push.
 * Manually constructed to avoid the 520-byte cap in some script builders.
 *
 * Opcodes: 0x6a=OP_RETURN, 0x4c=OP_PUSHDATA1, 0x4d=OP_PUSHDATA2, 0x4e=OP_PUSHDATA4
 */
function buildOpReturnScript(data: Uint8Array): Uint8Array {
    const n = data.length;
    let script: Uint8Array;

    if (n <= 75) {
        script = new Uint8Array(2 + n);
        script[0] = 0x6a; // OP_RETURN
        script[1] = n;
        script.set(data, 2);
    } else if (n <= 255) {
        script = new Uint8Array(3 + n);
        script[0] = 0x6a;
        script[1] = 0x4c; // OP_PUSHDATA1
        script[2] = n;
        script.set(data, 3);
    } else if (n <= 65535) {
        script = new Uint8Array(4 + n);
        script[0] = 0x6a;
        script[1] = 0x4d; // OP_PUSHDATA2
        new DataView(script.buffer).setUint16(2, n, true);
        script.set(data, 4);
    } else {
        script = new Uint8Array(6 + n);
        script[0] = 0x6a;
        script[1] = 0x4e; // OP_PUSHDATA4
        new DataView(script.buffer).setUint32(2, n, true);
        script.set(data, 6);
    }

    return script;
}
