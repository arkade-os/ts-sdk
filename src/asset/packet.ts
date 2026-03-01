import { hex } from "@scure/base";
import { Script } from "@scure/btc-signer";
import { concatBytes, equalBytes } from "@scure/btc-signer/utils.js";
import { ARKADE_MAGIC, MARKER_ASSET_PAYLOAD, AssetRefType } from "./types";
import { AssetGroup } from "./assetGroup";
import { BufferReader, BufferWriter } from "./utils";
import { TransactionOutput } from "@scure/btc-signer/psbt";
import { Transaction } from "../utils/transaction";

export class AssetPacketNotFoundError extends Error {
    constructor(txid: string) {
        super(`asset packet not found in tx ${txid}`);
        this.name = "AssetPacketNotFoundError";
    }
}

/**
 * Packet represents a collection of asset groups.
 * A packet is encoded in OP_RETURN output of an asset transaction.
 * @param groups - the asset groups in the packet
 */
export class Packet {
    private constructor(readonly groups: AssetGroup[]) {}

    static create(groups: AssetGroup[]): Packet {
        const p = new Packet(groups);
        p.validate();
        return p;
    }

    static fromString(s: string): Packet {
        let buf: Uint8Array;
        try {
            buf = hex.decode(s);
        } catch {
            throw new Error("invalid output script format, must be hex");
        }
        return Packet.fromScript(buf);
    }

    static fromScript(script: Uint8Array): Packet {
        const rawPacket = extractRawPacketFromScript(script);
        const reader = new BufferReader(rawPacket);
        return Packet.fromReader(reader);
    }

    static fromTxOut(pkScript: Uint8Array): Packet {
        return Packet.fromScript(pkScript);
    }

    static fromTx(tx: Transaction): Packet {
        for (let i = 0; i < tx.outputsLength; i++) {
            try {
                const output = tx.getOutput(i);
                if (!output?.script) {
                    continue;
                }
                return Packet.fromScript(output.script);
            } catch (error) {
                continue;
            }
        }

        throw new AssetPacketNotFoundError(tx.id);
    }

    static isAssetPacket(script: Uint8Array): boolean {
        try {
            extractRawPacketFromScript(script);
            return true;
        } catch {
            return false;
        }
    }

    leafTxPacket(intentTxid: Uint8Array): Packet {
        const leafGroups = this.groups.map((group) =>
            group.toBatchLeafAssetGroup(intentTxid)
        );
        return new Packet(leafGroups);
    }

    txOut(): Required<Pick<TransactionOutput, "script" | "amount">> {
        return {
            script: this.serialize(),
            amount: 0n,
        };
    }

    serialize(): Uint8Array {
        const writer = new BufferWriter();
        writer.writeVarUint(this.groups.length);
        for (const group of this.groups) {
            group.serializeTo(writer);
        }
        const packetData = writer.toBytes();

        const data = concatBytes(
            ARKADE_MAGIC,
            new Uint8Array([MARKER_ASSET_PAYLOAD]),
            packetData
        );
        return buildOpReturnScript(data);
    }

    toString(): string {
        return hex.encode(this.serialize());
    }

    validate(): void {
        if (this.groups.length === 0) {
            throw new Error("missing assets");
        }

        for (const group of this.groups) {
            if (
                group.controlAsset !== null &&
                group.controlAsset.ref.type === AssetRefType.ByGroup &&
                group.controlAsset.ref.groupIndex >= this.groups.length
            ) {
                throw new Error(
                    `invalid control asset group index, ${group.controlAsset.ref.groupIndex} out of range [0, ${this.groups.length - 1}]`
                );
            }
        }
    }

    private static fromReader(reader: BufferReader): Packet {
        const groups = parseAssetGroups(reader);
        const packet = new Packet(groups);
        packet.validate();
        return packet;
    }
}

/**
 * Structurally parse asset groups from a BufferReader without logical
 * validation (e.g. group index bounds).  Used by the trial-parse scanner
 * to distinguish real asset markers from identical byte values inside
 * other records.
 */
function parseAssetGroups(reader: BufferReader): AssetGroup[] {
    const count = Number(reader.readVarUint());
    const groups: AssetGroup[] = [];
    for (let i = 0; i < count; i++) {
        groups.push(AssetGroup.fromReader(reader));
    }
    return groups;
}

/**
 * Extract asset packet bytes from an OP_RETURN script.
 *
 * The TLV stream after the ARK magic may contain records in any order.
 * The asset record is identified by the MarkerAssetPayload (0x00) type
 * byte. The function scans for the marker and trial-parses to distinguish
 * real markers from identical byte values embedded inside other records.
 */
function extractRawPacketFromScript(script: Uint8Array): Uint8Array {
    if (!script || script.length === 0) {
        throw new Error("missing output script");
    }

    let decoded: ReturnType<typeof Script.decode>;
    try {
        decoded = Script.decode(script);
    } catch {
        throw new Error("invalid OP_RETURN output script");
    }

    if (decoded.length === 0 || decoded[0] !== "RETURN") {
        throw new Error("OP_RETURN not found in output script");
    }

    // concat all data pushes after RETURN
    const dataPushes = decoded
        .slice(1)
        .filter((item): item is Uint8Array => item instanceof Uint8Array);
    if (dataPushes.length === 0) {
        throw new Error("missing OP_RETURN data");
    }

    const payload = concatBytes(...dataPushes);

    if (payload.length < ARKADE_MAGIC.length + 1) {
        throw new Error("invalid script length");
    }

    const magicSlice = new Uint8Array(payload.slice(0, ARKADE_MAGIC.length));
    if (!equalBytes(magicSlice, ARKADE_MAGIC)) {
        throw new Error(
            `invalid magic prefix, got ${hex.encode(magicSlice)} want ${hex.encode(ARKADE_MAGIC)}`
        );
    }

    const tlvData = payload.slice(ARKADE_MAGIC.length);

    // Scan for the asset marker byte — it may not be the first record.
    for (let i = 0; i < tlvData.length; i++) {
        if (tlvData[i] !== MARKER_ASSET_PAYLOAD) continue;

        const candidate = tlvData.slice(i + 1);
        if (candidate.length === 0) continue;

        try {
            parseAssetGroups(new BufferReader(candidate));
            return candidate;
        } catch {
            // False positive — 0x00 byte is part of another record.
            continue;
        }
    }

    throw new Error("asset marker not found in TLV stream");
}

function buildOpReturnScript(data: Uint8Array): Uint8Array {
    return Script.encode(["RETURN", data]);
}
