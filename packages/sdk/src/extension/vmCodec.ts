import {
    type AssetGroupLike,
    type AssetIdLike,
    type AssetPacketLike,
    type AssetRefLike,
    type EmulatorEntryLike,
    type ExtensionCodec,
    type ExtensionLike,
    isExtensionScript,
    ScriptTokenizer,
    type VmTx,
    type VmTxOut,
} from "../arkade/vm";
import {
    AssetGroup,
    AssetId,
    AssetInput,
    AssetInputs,
    AssetInputType,
    AssetOutput,
    AssetOutputs,
    AssetRef,
    AssetRefType,
    MetadataList,
    Packet,
} from "./asset";
import { MASK_ASSET_ID, MASK_CONTROL_ASSET, MASK_METADATA } from "./asset/types";
import { EmulatorPacket } from "./emulator";
import { Extension } from "./index";
import { type ExtensionPacket, UnknownPacket } from "./packet";
import { BufferReader } from "./utils";

// The VM must accept exactly what ark-lib and the emulator accept, which is not what the SDK
// codecs accept, so this file reuses their pieces and re-applies Go's rules around them.

const maxAssetCount = 1000n;
const maxEmulatorEntries = 1000;
const maxEmulatorScript = 10_000;
const maxEmulatorWitness = 1_000_000;
const maxEmulatorTotal = maxEmulatorScript + maxEmulatorWitness;
const maxWitnessItem = 10_000;
const zeroTxid = new Uint8Array(32);

// ark-lib reverses txids on the wire; the VM wants chainhash order
const internalOrder = (wire: Uint8Array): Uint8Array => wire.slice().reverse();

const idLike = (id: AssetId): AssetIdLike => ({
    txid: internalOrder(id.txid),
    index: id.groupIndex,
});

function refLike({ ref }: AssetRef): AssetRefLike {
    return ref.type === AssetRefType.ByID
        ? { type: ref.type, assetId: idLike(ref.assetId), groupIndex: 0 }
        : { type: ref.type, assetId: { txid: zeroTxid, index: 0 }, groupIndex: ref.groupIndex };
}

function readCount(r: BufferReader): number {
    const n = r.readVarUint();
    if (n > maxAssetCount) throw new Error(`count ${n} exceeds ${maxAssetCount}`);
    return Number(n);
}

function readGroup(r: BufferReader): [AssetGroup, AssetGroupLike] {
    const presence = r.readByte();
    const assetId = presence & MASK_ASSET_ID ? AssetId.fromReader(r) : null;
    const control = presence & MASK_CONTROL_ASSET ? AssetRef.fromReader(r) : null;
    const metadata = presence & MASK_METADATA ? MetadataList.fromReader(r).items : [];
    const inputs = Array.from({ length: readCount(r) }, () => AssetInput.fromReader(r));
    if (new Set(inputs.map((i) => i.vin)).size < inputs.length) {
        throw new Error("all inputs must have unique vin");
    }
    AssetInputs.create(inputs);
    const outputs = AssetOutputs.create(
        Array.from({ length: readCount(r) }, () => AssetOutput.fromReader(r)),
    ).outputs;
    // AssetGroup.validate also refuses an explicit id with neither inputs nor outputs; Go does not
    if (!assetId && inputs.length === 0 && outputs.length === 0) {
        throw new Error("empty asset group");
    }
    if (!assetId && inputs.length > 0) throw new Error("issuance must have no inputs");
    if (assetId && control) throw new Error("only issuance can have a control asset");
    const like: AssetGroupLike = {
        assetId: assetId && idLike(assetId),
        controlAsset: control && refLike(control),
        inputs: inputs.map(({ input }) => ({
            type: input.type,
            vin: input.vin,
            txid: input.type === AssetInputType.Proof ? internalOrder(input.txid) : zeroTxid,
            amount: input.amount,
        })),
        outputs: outputs.map((o) => ({
            type: AssetOutput.TYPE_LOCAL,
            vout: o.vout,
            amount: o.amount,
        })),
        metadata,
    };
    return [new AssetGroup(assetId, control, inputs, outputs, metadata), like];
}

function parseAssetPacket(data: Uint8Array): { packet: Packet; groups: AssetPacketLike } {
    const r = new BufferReader(data);
    const read = Array.from({ length: readCount(r) }, () => readGroup(r));
    if (r.remaining() > 0) {
        throw new Error(`invalid packet length, left ${r.remaining()} unknown bytes to read`);
    }
    return { packet: Packet.create(read.map(([g]) => g)), groups: read.map(([, like]) => like) };
}

interface ParsedExtension {
    readonly packets: ExtensionPacket[];
    readonly assetPacket: AssetPacketLike | null;
}

/** NewExtensionFromBytes: only the push after OP_RETURN is read, whatever follows it. */
function parseExtension(script: Uint8Array): ParsedExtension {
    const t = new ScriptTokenizer(script);
    t.next();
    t.next();
    const r = new BufferReader(t.data.subarray(3));
    const packets: ExtensionPacket[] = [];
    let assetPacket: AssetPacketLike | null = null;
    while (r.remaining() > 0) {
        const type = r.readByte();
        const length = r.readVarUint();
        // bytes.Reader.Read reports EOF for an empty read at the end, so a last empty packet fails
        if (length > BigInt(r.remaining()) || (length === 0n && r.remaining() === 0)) {
            throw new Error("missing packet data: EOF");
        }
        const data = r.readSlice(Number(length));
        if (type === Packet.PACKET_TYPE) {
            const parsed = parseAssetPacket(data);
            packets.push(parsed.packet);
            assetPacket = parsed.groups;
        } else {
            packets.push(new UnknownPacket(type, data));
        }
    }
    if (packets.length === 0) throw new Error("missing packets");
    if (new Set(packets.map((p) => p.type())).size < packets.length) {
        throw new Error("duplicate packet type");
    }
    return { packets, assetPacket };
}

// wire.ReadVarInt refuses a CompactSize a shorter form could hold; BufferReader accepts it
function readVarInt(r: BufferReader): number {
    const before = r.remaining();
    const n = r.readCompactSize();
    if (before - r.remaining() !== (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5)) {
        throw new Error(`non-canonical varint ${n}`);
    }
    return n;
}

// txutils.ReadTxWitness: bytes after the last item are ignored
function readTxWitness(blob: Uint8Array): Uint8Array[] {
    const r = new BufferReader(blob);
    const count = readVarInt(r);
    if (count > r.remaining()) throw new Error(`invalid witness count: ${count}`);
    return Array.from({ length: count }, () => {
        const n = readVarInt(r);
        if (n > maxWitnessItem) throw new Error("witness is larger than the max allowed size");
        return r.readSlice(n);
    });
}

// the SDK writes an absent witness as witness_len = 0, which is serializeEmulatorPacketMasked
const withoutWitnesses = (entries: readonly EmulatorEntryLike[]): EmulatorPacket =>
    EmulatorPacket.create(entries.map(({ vin, script }) => ({ vin, script })));

/** DeserializeEmulatorPacket, which EmulatorPacket.fromBytes is laxer than. */
function decodeEmulatorPacket(data: Uint8Array): EmulatorEntryLike[] {
    const r = new BufferReader(data);
    const count = readVarInt(r);
    if (count > maxEmulatorEntries) throw new Error(`emulator entry count ${count} exceeded`);
    let total = 0;
    const take = (n: number, max: number): Uint8Array => {
        total += n;
        if (n > max || total > maxEmulatorTotal) throw new Error("emulator entry too large");
        return r.readSlice(n);
    };
    const entries: EmulatorEntryLike[] = [];
    for (let i = 0; i < count; i++) {
        const vin = r.readUint16LE();
        const script = take(readVarInt(r), maxEmulatorScript);
        const witness = take(readVarInt(r), maxEmulatorWitness);
        entries.push({ vin, script, witness: witness.length > 0 ? readTxWitness(witness) : [] });
    }
    if (r.remaining() !== 0) throw new Error(`unexpected ${r.remaining()} trailing bytes`);
    withoutWitnesses(entries);
    return entries;
}

const extensionIndex = (tx: VmTx): number =>
    tx.outputs.findIndex((o) => isExtensionScript(o.script));

function readExtension(tx: VmTx): ExtensionLike | null {
    const i = extensionIndex(tx);
    if (i < 0) return null;
    const { packets, assetPacket } = parseExtension(tx.outputs[i].script);
    return {
        packets: packets.map((p) => ({ type: p.type(), serialize: () => p.serialize() })),
        assetPacket,
    };
}

function findEmulatorPacket(tx: VmTx): EmulatorEntryLike[] | null {
    const i = extensionIndex(tx);
    if (i < 0) return null;
    const packet = parseExtension(tx.outputs[i].script).packets.find(
        (p) => p.type() === EmulatorPacket.PACKET_TYPE,
    );
    if (!packet) return null;
    const entries = decodeEmulatorPacket(packet.serialize());
    const bad = entries.find((e) => e.vin >= tx.inputs.length);
    if (bad) throw new Error(`vin ${bad.vin} out of range, tx has ${tx.inputs.length} inputs`);
    return entries;
}

/** Fail-open like Go: any parse failure leaves the output unmasked. No vin check, unlike find. */
function maskExtensionOutput(tx: VmTx): { index: number; output: VmTxOut } | null {
    const index = extensionIndex(tx);
    if (index < 0) return null;
    const { value, script } = tx.outputs[index];
    let packets: ExtensionPacket[];
    try {
        packets = parseExtension(script).packets;
        const j = packets.findIndex((p) => p.type() === EmulatorPacket.PACKET_TYPE);
        if (j < 0) return null;
        packets[j] = withoutWitnesses(decodeEmulatorPacket(packets[j].serialize()));
    } catch {
        return null;
    }
    return { index, output: { value, script: Extension.create(packets).serialize() } };
}

export const vmExtensionCodec: ExtensionCodec = {
    readExtension,
    findEmulatorPacket,
    maskExtensionOutput,
};
