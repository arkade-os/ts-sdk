import { hex } from "@scure/base";

import { type ExtensionPacket, UnknownPacket } from "../../../extension";
import {
    AssetGroup,
    AssetId,
    AssetInput,
    AssetOutput,
    AssetRef,
    Metadata,
    Packet,
} from "../../../extension/asset";
import { EmulatorPacket } from "../../../extension/emulator";
import { vmExtensionCodec } from "../../../extension/vmCodec";
import { type OutPoint, serializeWitness, type VmTx } from "../../vm";
import { displayHash } from "../../vm/fetchers-ark";
import { encodeAdvertisement, records, type Template, within } from "../compile";
import { fail } from "../errors";
import { type Draft, messageOf, type Src } from "./draft";
import type { Instance } from "./instance";
import type { Allocation } from "./output";

export interface Entry {
    vin: number;
    script: Uint8Array;
    /** Bottom of the stack first. */
    witness: Uint8Array[];
}

const ADVERTISEMENT = 5;
const GENERATED = new Set([Packet.PACKET_TYPE, EmulatorPacket.PACKET_TYPE, ADVERTISEMENT]);
const MAX_EMULATOR_ENTRIES = 1000;
const MAX_ASSET_GROUPS = 1000;
const q = JSON.stringify;
const utf8 = new TextEncoder();
const outpoint = (op: OutPoint) => `${displayHash(op.txid)}:${op.index}`;
const handledKey = (op: OutPoint, type: number) => `${hex.encode(op.txid)}/${type}`;

// Go's "%w: <prefix>: %v": the cause's kinds are dropped
function as<T>(prefix: string, f: () => T): T {
    try {
        return f();
    } catch (e) {
        throw fail("ineligible", `${prefix}: ${messageOf(e)}`);
    }
}

/** The packets, in ascending type. */
export function extension(
    i: Instance,
    d: Draft,
    sources: readonly Src[],
    a: Allocation,
    entries: readonly Entry[],
): ExtensionPacket[] {
    const t = i.tmpl;
    const ext: ExtensionPacket[] = [];
    const assets = assetPacket(i, d, sources, a);
    if (assets) ext.push(assets);
    if (entries.length > 0) {
        ext.push(
            as("emulator packet", () => {
                if (entries.length > MAX_EMULATOR_ENTRIES) {
                    throw new Error(`max emulator entry count exceeded, got=${entries.length}`);
                }
                // an empty witness still serializes as its zero count
                return EmulatorPacket.create(
                    entries.map((e) => ({ ...e, witness: serializeWitness(e.witness) })),
                );
            }),
        );
    }
    if (!t.packets) {
        if (ext.length > 0) throw fail("invalid_template", "assets or a covenant need packets");
        unmatched(sources, new Set(), false);
        return [];
    }
    const emitted = new Map<number, ExtensionPacket>();
    const handled = new Set<string>();
    for (const r of t.packets.rules) {
        const src = sources[r.from];
        handled.add(handledKey(src.outpoint, r.type));
        if (r.action === "copy") {
            const body = findPacket(src.tx as VmTx, r.type);
            if (body === undefined) {
                throw fail(
                    "ineligible",
                    `input ${q(t.inputs[r.from].name)} has no packet ${r.type} to copy`,
                );
            }
            emitted.set(r.type, new UnknownPacket(r.type, body));
        } else if (r.action === "emit") {
            const body = within(`packet ${r.type}`, () =>
                i.resolve(r.data ?? [], d, d.index(r.from)),
            );
            if (body.length === 0) throw fail("ineligible", `packet ${r.type} is empty`);
            emitted.set(r.type, new UnknownPacket(r.type, body));
        }
    }
    unmatched(sources, handled, t.packets.drop);
    for (const type of [...emitted.keys()].sort((x, y) => x - y)) {
        ext.push(emitted.get(type) as ExtensionPacket);
    }
    if (t.packets.adverts.length > 0) {
        let body: Uint8Array;
        try {
            body = encodeAdvertisement(records(t, t.packets, hex.decode(t.id)));
        } catch (e) {
            throw fail("invalid_template", messageOf(e));
        }
        ext.push(new UnknownPacket(ADVERTISEMENT, body));
    }
    return ext;
}

/** The body of the first packet of `type` in tx's extension, as packets.Find reads it. */
function findPacket(tx: VmTx, type: number): Uint8Array | undefined {
    try {
        return vmExtensionCodec
            .readExtension(tx)
            ?.packets.find((p) => p.type === type)
            ?.serialize();
    } catch {
        return undefined;
    }
}

/** Fails on a source packet no rule handles, unless dropped; packets this engine writes pass. */
function unmatched(sources: readonly Src[], handled: ReadonlySet<string>, drop: boolean): void {
    for (const s of sources) {
        let ext: ReturnType<typeof vmExtensionCodec.readExtension>;
        try {
            ext = vmExtensionCodec.readExtension(s.tx as VmTx);
        } catch (e) {
            throw fail(
                "ineligible",
                `source ${outpoint(s.outpoint)}: malformed extension: ${messageOf(e)}`,
            );
        }
        for (const p of ext?.packets ?? []) {
            if (GENERATED.has(p.type) || drop || handled.has(handledKey(s.outpoint, p.type))) {
                continue;
            }
            throw fail(
                "ineligible",
                `source ${outpoint(s.outpoint)} carries packet ${p.type} that no rule handles`,
            );
        }
    }
}

/** Undefined when no asset moves. New issues take the first groups in order, then ids sorted. */
function assetPacket(
    i: Instance,
    d: Draft,
    sources: readonly Src[],
    a: Allocation,
): Packet | undefined {
    const t = i.tmpl;
    const ids = new Set<string>();
    for (const m of a.assets.slice(0, t.outputs.length)) for (const id of m.keys()) ids.add(id);
    for (const s of sources) for (const as of s.assets) ids.add(hex.encode(as.id));
    const fresh = new Map<number, number>();
    t.issues.forEach((is, j) => {
        if (is.asset === undefined) fresh.set(j, fresh.size);
    });
    const groups: AssetGroup[] = [];
    t.issues.forEach((is, j) => {
        if (is.asset !== undefined) return;
        groups.push(as(`issue ${q(is.name)}`, () => issueGroup(i, d, a, j, fresh)));
    });
    for (const id of [...ids].sort()) {
        groups.push(as(`asset ${id}`, () => assetGroup(t, sources, a, id)));
    }
    if (groups.length === 0) return undefined;
    return as("assets packet", () => {
        if (groups.length > MAX_ASSET_GROUPS) {
            throw new Error(`invalid asset group count, max=1000, got=${groups.length}`);
        }
        return Packet.create(groups);
    });
}

// The SDK's AssetGroup.create refuses more than ark-lib does, so Go's checks are applied here.
function issueGroup(
    i: Instance,
    d: Draft,
    a: Allocation,
    j: number,
    fresh: ReadonlyMap<number, number>,
): AssetGroup {
    const t = i.tmpl;
    const is = t.issues[j];
    const outs: AssetOutput[] = [];
    a.minted[j].forEach((n, k) => {
        if (n > 0n) outs.push(AssetOutput.create(t.outputs[k].index, n));
    });
    let ref: AssetRef | null = null;
    if (is.control && is.control.issue >= 0) {
        ref = AssetRef.fromGroupIndex(fresh.get(is.control.issue) as number);
    } else if (is.control?.asset) {
        ref = AssetRef.fromId(AssetId.fromBytes(i.decoded(is.control.asset, "asset", d, 0)));
    }
    const md = is.metadata.map((m) => [m.key, i.resolve(m.value, d, d.index(0))] as const);
    if (outs.length === 0) throw new Error("empty asset group");
    return new AssetGroup(
        null,
        ref,
        [],
        outs,
        md.map(([key, value]) => Metadata.create(utf8.encode(key), value)),
    );
}

function assetGroup(t: Template, sources: readonly Src[], a: Allocation, id: string): AssetGroup {
    const ins: AssetInput[] = [];
    sources.forEach((s, slot) => {
        const held = s.assets
            .filter((as) => hex.encode(as.id) === id)
            .reduce((sum, as) => sum + as.amount, 0n);
        if (held > 0n) ins.push(AssetInput.create(slot, held));
    });
    const outs: AssetOutput[] = [];
    t.outputs.forEach((o, k) => {
        const n = a.assets[k].get(id) ?? 0n;
        if (n > 0n) outs.push(AssetOutput.create(o.index, n));
    });
    return new AssetGroup(AssetId.fromString(id), null, ins, outs, []);
}
