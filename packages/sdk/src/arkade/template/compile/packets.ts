import { hex } from "@scure/base";

import type * as schema from "../schema";
import { bad, bind, type Compiler, inputIndex, q } from "./compiler";
import { type Advert, arkade, type PacketSpec, type Rule, type Template } from "./model";

const MAX_ADVERTISEMENT = 520;

export interface AdvertRecord {
    template: Uint8Array;
    outputs: number[];
}

/** Indexed outputs without output_index leave `packets` undefined; unindexed ones never do. */
export function packets(c: Compiler): void {
    const s: schema.Packets = c.doc.packets ?? {};
    const indexed = c.doc.outputs[0].index !== undefined;
    if (s.outputIndex !== undefined && !indexed) {
        throw bad("output_index goes with indexed outputs only");
    }
    if (s.outputIndex === undefined && indexed) {
        if (arkade(c.t) || (s.rules?.length ?? 0) > 0 || (s.advertise?.length ?? 0) > 0) {
            throw bad("indexed outputs place the extension with packets.output_index");
        }
        return;
    }
    const ps: PacketSpec = { index: -1, drop: s.unmatched === "drop", rules: [], adverts: [] };
    if (s.outputIndex !== undefined) {
        if (s.outputIndex > 0xffff) throw bad("output_index out of range");
        ps.index = s.outputIndex;
    }
    // Go compares each rule with every earlier one of its type. An accepted type never holds an emit
    // beside a copy, nor copies from two inputs, so these sets give the same verdict and message.
    const types = new Map<number, { emit: boolean; copies: Set<number>; drops: Set<number> }>();
    for (const sr of s.rules ?? []) {
        const x = rule(c, sr);
        const o = types.get(x.type) ?? { emit: false, copies: new Set(), drops: new Set() };
        types.set(x.type, o);
        if (o.emit && x.action === "emit") throw bad(`two emit rules for packet type ${x.type}`);
        // the extension holds one packet per type: a copy goes only with the same copy or a drop
        const conflict =
            x.action === "emit"
                ? o.copies.size > 0
                : x.action === "copy"
                  ? o.emit || (o.copies.size > 0 && !o.copies.has(x.from)) || o.drops.has(x.from)
                  : o.copies.has(x.from);
        if (conflict) throw bad(`copy conflicts with another rule for packet type ${x.type}`);
        if (x.action === "emit") o.emit = true;
        else (x.action === "copy" ? o.copies : o.drops).add(x.from);
        ps.rules.push(x);
    }
    const advertised = new Set<number>();
    for (const sa of s.advertise ?? []) ps.adverts.push(advert(c, sa, advertised));
    if (ps.adverts.length > 0) {
        try {
            encodeAdvertisement(records(c.t, ps, new Uint8Array(32)));
        } catch (e) {
            throw bad((e as Error).message);
        }
    }
    c.t.packets = ps;
}

function rule(c: Compiler, s: schema.Rule): Rule {
    const r: Rule = {
        type: s.type,
        action: s.action as Rule["action"],
        from: inputIndex(c, s.from, "rule"),
    };
    if (s.data !== undefined) r.data = bind(c, s.data, "");
    return r;
}

function advert(c: Compiler, s: schema.Advert, advertised: Set<number>): Advert {
    const { t } = c;
    const self = s.template === "self";
    const ad: Advert = {
        self,
        target: self ? new Uint8Array(32) : hex.decode(s.template),
        outputs: [],
    };
    for (const name of s.outputs) {
        const i = c.outputSlots.get(name) ?? -1;
        if (i < 0) throw bad(`advertisement names no output: ${q(name)}`);
        if (advertised.has(i)) throw bad(`output ${q(name)} is advertised twice`);
        if (t.type === "proof" && t.outputs[i].onchain) {
            throw bad("an intent advertises only offchain outputs");
        }
        advertised.add(i);
        ad.outputs.push(i);
    }
    if (self && ad.outputs.length !== t.inputs.length) {
        throw bad("advertising self takes one output per input");
    }
    ad.outputs.forEach((i, slot) => {
        if (self && t.outputs[i].onchain !== t.inputs[slot].onchain) {
            throw bad(
                `output ${q(t.outputs[i].name)} does not match the type of input slot ${q(t.inputs[slot].name)}`,
            );
        }
    });
    if (self && t.variables.size > 0)
        throw bad("a template with variables cannot advertise itself");
    return ad;
}

/** The advertisements, `self` standing for `id`. */
export function records(t: Template, ps: PacketSpec, id: Uint8Array): AdvertRecord[] {
    return ps.adverts.map((ad) => ({
        template: ad.self ? id : ad.target,
        outputs: ad.outputs.map((k) => t.outputs[k].index),
    }));
}

/** version 0x01, then per record ordered by lowest output: len[2 LE] || template[32] || outputs[2 LE]. */
export function encodeAdvertisement(records: readonly AdvertRecord[]): Uint8Array {
    if (records.length === 0) throw new Error("packets: advertisement needs at least one record");
    records.forEach((r, i) => {
        if (r.outputs.length === 0)
            throw new Error(`packets: record ${i} needs at least one output`);
    });
    const sorted = [...records].sort((x, y) => Math.min(...x.outputs) - Math.min(...y.outputs));
    const out = [0x01];
    sorted.forEach((r, i) => {
        const n = r.template.length + 2 * r.outputs.length;
        if (n > 0xffff) throw new Error(`packets: record ${i} body too long: ${n} bytes`);
        out.push(n & 0xff, n >> 8, ...r.template);
        for (const o of r.outputs) out.push(o & 0xff, o >> 8);
    });
    if (out.length > MAX_ADVERTISEMENT) {
        throw new Error(
            `packets: advertisement too long: ${out.length} bytes, max ${MAX_ADVERTISEMENT}`,
        );
    }
    return Uint8Array.from(out);
}
