import { equalBytes } from "@noble/curves/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { BigNum } from "../bignum";
import type { Engine } from "../engine";
import { scriptError } from "../errors";
import type { FamilyHandlers, OpcodeHandler } from "../opcodes";
import type { AssetGroupLike, AssetIdLike, AssetMetadataLike, AssetPacketLike } from "../types";

const maxAssetGroupIndex = 65535;
const assetRefByID = 1;
const assetRefByGroup = 2;
const assetInputIntent = 2;

export const stackError = (message: string) => scriptError("ErrInvalidStackOperation", message);

const sameId = (a: AssetIdLike, b: AssetIdLike): boolean =>
    a.index === b.index && equalBytes(a.txid, b.txid);

function packetOf(vm: Engine): AssetPacketLike {
    if (!vm.assetPacket) throw stackError("no asset packet");
    return vm.assetPacket;
}

function groupAt(packet: AssetPacketLike, k: number): AssetGroupLike {
    if (k >= packet.length || k < 0) throw stackError("group index out of range");
    return packet[k];
}

/** An explicit id naming this tx would alias the fresh issuance at that position, so it fails. */
export function resolveAssetID(txHash: Uint8Array, k: number, group: AssetGroupLike): AssetIdLike {
    if (group.assetId) {
        if (equalBytes(group.assetId.txid, txHash)) {
            throw stackError("explicit asset id collides with fresh issuance identity");
        }
        return group.assetId;
    }
    if (k > maxAssetGroupIndex) throw stackError("group position exceeds max asset_gidx");
    return { txid: txHash, index: k };
}

export function popAssetID(vm: Engine): AssetIdLike {
    const index = vm.dstack.popInt();
    const txid = vm.dstack.popByteArray();
    if (txid.length !== 32) throw stackError("invalid asset_txid length");
    if (index < 0 || index > maxAssetGroupIndex) throw stackError("asset_gidx out of range");
    return { txid, index };
}

function pushId(vm: Engine, id: AssetIdLike): void {
    vm.dstack.pushByteArray(id.txid);
    vm.dstack.pushInt(id.index);
}

function pushAmount(vm: Engine, amount: bigint): void {
    vm.dstack.pushBigNum(BigNum.fromUint64(amount));
}

const sum = (entries: readonly { readonly amount: bigint }[]): BigNum =>
    new BigNum(
        entries.reduce((s, e) => s + e.amount, 0n),
        true,
    );

// Plain sha256, unsorted, odd node carried up: not ark-lib's tagged metadata tree.
function metadataRoot(metadata: readonly AssetMetadataLike[]): Uint8Array {
    if (metadata.length === 0) return new Uint8Array(32);
    let level: Uint8Array[] = metadata.map((md) => sha256(md.serialize()));
    while (level.length > 1) {
        const next: Uint8Array[] = [];
        for (let i = 0; i < level.length; i += 2) {
            const right = level[i + 1];
            next.push(right ? sha256.create().update(level[i]).update(right).digest() : level[i]);
        }
        level = next;
    }
    return level[0];
}

function bySource(source: number, inputs: () => void, outputs: () => void): void {
    if (source < 0 || source > 2) throw stackError("invalid source value");
    if (source !== 1) inputs();
    if (source !== 0) outputs();
}

type Side = (group: AssetGroupLike) => readonly (readonly [index: number, amount: bigint])[];

const outputsOf: Side = (g) => g.outputs.map((o) => [o.vout, o.amount] as const);
const inputsOf: Side = (g) => g.inputs.map((i) => [i.vin, i.amount] as const);

function countAt(side: Side): OpcodeHandler {
    return (_op, _data, vm) => {
        const packet = packetOf(vm);
        const at = vm.dstack.popInt();
        let count = 0;
        for (const group of packet) count += side(group).filter(([i]) => i === at).length;
        vm.dstack.pushInt(count);
    };
}

function assetAt(side: Side): OpcodeHandler {
    return (_op, _data, vm) => {
        const packet = packetOf(vm);
        const t = vm.dstack.popInt();
        const at = vm.dstack.popInt();
        if (t < 0) throw stackError("asset index out of range");
        const txHash = vm.txID();
        let seen = 0;
        for (const [k, group] of packet.entries()) {
            const id = resolveAssetID(txHash, k, group);
            for (const [i, amount] of side(group)) {
                if (i !== at) continue;
                if (seen++ === t) {
                    pushId(vm, id);
                    pushAmount(vm, amount);
                    return;
                }
            }
        }
        throw stackError("asset index out of range");
    };
}

function lookupAt(side: Side): OpcodeHandler {
    return (_op, _data, vm) => {
        const packet = packetOf(vm);
        const want = popAssetID(vm);
        const at = vm.dstack.popInt();
        const txHash = vm.txID();
        for (const [k, group] of packet.entries()) {
            if (!sameId(resolveAssetID(txHash, k, group), want)) continue;
            const hit = side(group).find(([i]) => i === at);
            if (hit) {
                pushAmount(vm, hit[1]);
                vm.dstack.pushInt(1);
                return;
            }
        }
        pushAmount(vm, 0n);
        vm.dstack.pushInt(0);
    };
}

export const assetsHandlers: FamilyHandlers<"assets"> = {
    OP_INSPECTNUMASSETGROUPS: (_op, _data, vm) => vm.dstack.pushInt(packetOf(vm).length),
    OP_INSPECTASSETGROUPASSETID: (_op, _data, vm) => {
        const packet = packetOf(vm);
        const k = vm.dstack.popInt();
        pushId(vm, resolveAssetID(vm.txID(), k, groupAt(packet, k)));
    },
    OP_INSPECTASSETGROUPCTRL: (_op, _data, vm) => {
        const packet = packetOf(vm);
        const ctrl = groupAt(packet, vm.dstack.popInt()).controlAsset;
        if (!ctrl) {
            vm.dstack.pushByteArray(new Uint8Array(0));
            vm.dstack.pushInt(0);
            vm.dstack.pushInt(0);
            return;
        }
        if (ctrl.type === assetRefByID) {
            pushId(vm, ctrl.assetId);
        } else if (ctrl.type === assetRefByGroup) {
            const k = ctrl.groupIndex;
            if (k >= packet.length) throw stackError("control asset group index out of range");
            pushId(vm, resolveAssetID(vm.txID(), k, packet[k]));
        } else {
            throw stackError("invalid control asset type");
        }
        vm.dstack.pushInt(1);
    },
    OP_FINDASSETGROUPBYASSETID: (_op, _data, vm) => {
        const packet = packetOf(vm);
        const want = popAssetID(vm);
        const txHash = vm.txID();
        const k = packet.findIndex((group, k) => sameId(resolveAssetID(txHash, k, group), want));
        vm.dstack.pushInt(Math.max(k, 0));
        vm.dstack.pushInt(k < 0 ? 0 : 1);
    },
    OP_INSPECTASSETGROUPMETADATAHASH: (_op, _data, vm) => {
        const packet = packetOf(vm);
        vm.dstack.pushByteArray(metadataRoot(groupAt(packet, vm.dstack.popInt()).metadata));
    },
    OP_INSPECTASSETGROUPNUM: (_op, _data, vm) => {
        const packet = packetOf(vm);
        const source = vm.dstack.popInt();
        const group = groupAt(packet, vm.dstack.popInt());
        bySource(
            source,
            () => vm.dstack.pushInt(group.inputs.length),
            () => vm.dstack.pushInt(group.outputs.length),
        );
    },
    OP_INSPECTASSETGROUP: (_op, _data, vm) => {
        const packet = packetOf(vm);
        const source = vm.dstack.popInt();
        const j = vm.dstack.popInt();
        const group = groupAt(packet, vm.dstack.popInt());
        if (source === 0) {
            if (j >= group.inputs.length || j < 0) throw stackError("input index out of range");
            const input = group.inputs[j];
            vm.dstack.pushInt(input.type);
            if (input.type === assetInputIntent) vm.dstack.pushByteArray(input.txid);
            vm.dstack.pushInt(input.vin);
            pushAmount(vm, input.amount);
        } else if (source === 1) {
            if (j >= group.outputs.length || j < 0) throw stackError("output index out of range");
            const output = group.outputs[j];
            vm.dstack.pushInt(1);
            vm.dstack.pushInt(output.vout);
            pushAmount(vm, output.amount);
        } else {
            throw stackError("invalid source value");
        }
    },
    OP_INSPECTASSETGROUPSUM: (_op, _data, vm) => {
        const packet = packetOf(vm);
        const source = vm.dstack.popInt();
        const group = groupAt(packet, vm.dstack.popInt());
        bySource(
            source,
            () => vm.dstack.pushBigNum(sum(group.inputs)),
            () => vm.dstack.pushBigNum(sum(group.outputs)),
        );
    },
    OP_INSPECTOUTASSETCOUNT: countAt(outputsOf),
    OP_INSPECTOUTASSETAT: assetAt(outputsOf),
    OP_INSPECTOUTASSETLOOKUP: lookupAt(outputsOf),
    OP_INSPECTINASSETCOUNT: countAt(inputsOf),
    OP_INSPECTINASSETAT: assetAt(inputsOf),
    OP_INSPECTINASSETLOOKUP: lookupAt(inputsOf),
};
