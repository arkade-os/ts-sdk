import { compareGo } from "../jcs";
import type * as schema from "../schema";
import { amount, bad, bind, type Compiler, inputIndex, q, slotType } from "./compiler";
import { construction } from "./inputs";
import {
    type AssetRoute,
    type Draw,
    hasProgram,
    type Issue,
    type Locking,
    type Output,
    outputIndex,
    sinks,
} from "./model";

// Assets compare as written; two spellings of one id are caught when routed.
const assetKey = (r: AssetRoute) => JSON.stringify([r.from, r.issue, r.spec]);

export function issues(c: Compiler): void {
    const given = c.doc.issues ?? [];
    const names = new Map<string, number>();
    given.forEach((s, k) => {
        if (names.has(s.name)) throw bad(`duplicate issue ${q(s.name)}`);
        names.set(s.name, k);
    });
    for (const s of given) {
        const is: Issue = { name: s.name, metadata: [] };
        if (s.asset !== undefined) is.asset = bind(c, { str: s.asset }, "asset");
        if (s.control && "issue" in s.control) {
            const k = names.get(s.control.issue);
            if (k === undefined || s.control.issue === s.name || given[k].asset !== undefined) {
                throw bad(
                    `issue ${q(s.name)}: control ${q(s.control.issue)} names no other new asset`,
                );
            }
            is.control = { issue: k };
        } else if (s.control) {
            is.control = { issue: -1, asset: bind(c, { str: s.control.asset }, "asset") };
        }
        for (const key of [...(s.metadata?.keys() ?? [])].sort(compareGo)) {
            const value = bind(c, { str: s.metadata?.get(key) as string }, "");
            is.metadata.push({ key, value });
        }
        c.t.issues.push(is);
    }
}

export function route(c: Compiler, s: schema.AssetRoute): AssetRoute {
    const r: AssetRoute = { from: -1, issue: -1 };
    if (s.issue !== undefined) {
        r.issue = c.t.issues.findIndex((is) => is.name === s.issue);
        if (r.issue < 0) throw bad(`asset route names no issue ${q(s.issue)}`);
        r.amount = amount(c, s.amount as schema.Binding);
        return r;
    }
    r.from = inputIndex(c, s.from as string, "asset route");
    if (c.t.inputs[r.from].onchain) {
        throw bad(`onchain input ${q(c.t.inputs[r.from].name)} carries no assets`);
    }
    if (s.asset !== undefined) {
        r.spec = s.asset;
        r.asset = bind(c, { str: s.asset }, "asset");
    }
    if (s.amount !== undefined) r.amount = amount(c, s.amount);
    return r;
}

export function output(c: Compiler, s: schema.Output): void {
    if (c.outputSlots.has(s.name)) throw bad(`duplicate output ${q(s.name)}`);
    let index = c.t.outputs.length;
    if (s.index !== undefined) {
        if (s.index > 0xffff) throw bad(`output ${q(s.name)} index out of range`);
        index = s.index;
    }
    const onchain = slotType(c, s.type);
    const draws: Draw[] = [];
    const drawn = new Set<number>();
    for (const sd of s.value.draws) {
        const from = inputIndex(c, sd.from, "value");
        if (drawn.has(from)) throw bad(`output ${q(s.name)} draws from input ${q(sd.from)} twice`);
        drawn.add(from);
        draws.push(sd.amount === undefined ? { from } : { from, amount: amount(c, sd.amount) });
    }
    const o: Output = {
        name: s.name,
        index,
        onchain,
        from: draws[0].from,
        draws,
        locking: locking(c, s.locking),
        assets: [],
        each: -1,
        coin: -1,
    };
    if ((s.assets?.length ?? 0) > 0 && onchain)
        throw bad(`output ${q(o.name)} cannot carry assets`);
    const routed = new Set<string>();
    for (const sr of s.assets ?? []) {
        const r = route(c, sr);
        if (routed.has(assetKey(r))) {
            throw bad(`output ${q(o.name)} routes an asset of an input twice`);
        }
        routed.add(assetKey(r));
        o.assets.push(r);
    }
    if (s.each !== undefined) {
        o.each = inputIndex(c, s.each, "each");
        if (o.draws.some((d) => d.from !== o.each) || o.assets.some((r) => r.from !== o.each)) {
            throw bad(
                `output ${q(o.name)} repeats per coin of ${q(s.each)} and takes from it alone`,
            );
        }
    }
    c.outputSlots.set(o.name, c.t.outputs.length);
    c.t.outputs.push(o);
}

function locking(c: Compiler, s: schema.Locking): Locking {
    if ("script" in s) return { from: -1, script: bind(c, { str: s.script }, "") };
    if ("from" in s) return { from: inputIndex(c, s.from, "locking") };
    const contract = construction(c, s.contract);
    if (contract.taptree !== undefined) {
        throw bad("a contract checked against a given taptree cannot lock an output");
    }
    return { from: -1, contract };
}

export function checkPrograms({ t }: Compiler): void {
    for (const o of t.outputs) {
        if (o.locking.contract && [...o.locking.contract.args.values()].some(hasProgram)) {
            throw bad(`output ${q(o.name)} binds an output program`);
        }
    }
    for (const i of t.inputs) {
        for (const b of i.contract.args.values()) {
            for (const p of b) {
                if (!("program" in p)) continue;
                const k = outputIndex(t, p.program);
                if (k < 0 || !t.outputs[k].locking.contract) {
                    throw bad(`program ${q(p.program)} names no output built from a contract`);
                }
            }
        }
    }
}

export function checkBalances({ t }: Compiler): void {
    const counts = t.inputs.map(() => 0);
    for (const o of t.outputs)
        for (const d of o.draws) if (d.amount === undefined) counts[d.from]++;
    t.inputs.forEach((input, i) => {
        const n = counts[i];
        if (n !== 1) throw bad(`input ${q(input.name)} needs exactly one remainder draw, has ${n}`);
    });
    const remainders = new Set<string>();
    const routed = t.issues.map(() => false);
    for (const s of sinks(t)) {
        for (const r of s.routes) {
            if (r.issue >= 0) routed[r.issue] = true;
            if (r.amount !== undefined) continue;
            if (remainders.has(assetKey(r))) {
                throw bad(
                    `input ${q(t.inputs[r.from].name)} has two remainder routes for one asset`,
                );
            }
            remainders.add(assetKey(r));
        }
    }
    const k = routed.indexOf(false);
    if (k >= 0) throw bad(`issue ${q(t.issues[k].name)} is routed to no output`);
}

export function checkPlacement({ t }: Compiler): void {
    if (t.packets && t.packets.index < 0) {
        const sorted = t.outputs.every((o, k) => k === 0 || !t.outputs[k - 1].onchain || o.onchain);
        if (t.type === "proof" && !sorted) {
            throw bad("a proof template lists its offchain outputs before its onchain ones");
        }
        return;
    }
    const offchain = t.outputs.filter((o) => !o.onchain).length;
    const idx = t.outputs.map((o) => o.index);
    if (t.packets) idx.push(t.packets.index);
    idx.sort((a, b) => a - b);
    if (idx.some((n, i) => n !== i))
        throw bad(`output indexes must fill 0..${idx.length - 1} once`);
    if (t.type !== "proof") return;
    if (t.outputs.some((o) => o.onchain === o.index < offchain)) {
        throw bad("an intent places offchain outputs, the extension, then onchain outputs");
    }
    if (t.packets && t.packets.index !== offchain) {
        throw bad("an intent places its extension after the offchain outputs");
    }
}
