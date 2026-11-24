import { type Document, identify } from "../document";
import { fail, wrap } from "../errors";
import type * as schema from "../schema";
import { type Artifacts, bad, type Compiler, q } from "./compiler";
import { fees, input, locks, schedules } from "./inputs";
import type { Template, TemplateType } from "./model";
import { checkBalances, checkPlacement, checkPrograms, issues, output, route } from "./outputs";
import { packets } from "./packets";
import { triggers } from "./triggers";

export type { Artifacts } from "./compiler";
export { numberOrZero, within } from "./compiler";
export { isCLTV } from "./inputs";
export * from "./model";
export { type AdvertRecord, encodeAdvertisement, records } from "./packets";

/**
 * Applies every cross-field rule of `doc` against `artifacts`, keyed by the id the document names.
 * Throws a TemplateError with stage "compile".
 */
export function compileDocument(doc: Document, artifacts: Artifacts = new Map()): Template {
    try {
        return compile(doc, artifacts);
    } catch (e) {
        throw wrap("compile", e);
    }
}

function compile(doc: Document, artifacts: Artifacts): Template {
    const s = doc.template;
    // from the template itself, so a hand-built Document cannot lend it another id
    const { id, spendId } = identify(s);
    const c: Compiler = {
        artifacts,
        definitions: new Map(),
        doc: s,
        named: new Set(),
        inputSlots: new Map(),
        outputSlots: new Map(),
        t: {
            id,
            spendId,
            type: s.type as TemplateType,
            requiredKeys: { server: false, emulator: false, cosigner: false },
            variables: new Map(s.variables),
            sealed: new Set(),
            inputs: [],
            outputs: [],
            issues: [],
            burns: [],
            groups: [],
            triggers: [],
            artifacts: [],
        },
    };
    unsupported(s);
    for (const x of s.delegation?.sealed ?? []) {
        if (!c.t.variables.has(x.name)) throw bad(`sealed ${q(x.name)} is not a declared variable`);
        c.t.sealed.add(x.name);
    }
    for (const i of inTxOrder(s.inputs)) input(c, i);
    issues(c);
    for (const o of s.outputs) output(c, o);
    for (const b of s.burns ?? []) c.t.burns.push(route(c, b));
    for (const check of [
        schedules,
        checkPrograms,
        checkBalances,
        fees,
        packets,
        triggers,
        checkPlacement,
        confineTaptrees,
        locks,
    ]) {
        check(c);
    }
    return c.t;
}

function unsupported(s: schema.Template): void {
    const d = s.delegation;
    if (!d) return;
    for (const x of d.sealed ?? []) {
        if (x.scheme !== undefined) {
            throw fail("unsupported", `sealed scheme ${x.scheme} is not supported`);
        }
    }
    const all = [...(d.trigger?.values() ?? [])].some((tr) => tr.allOutputs);
    const indexed = (xs: { index?: number }[]) => xs.some((x) => x.index !== undefined);
    if (all && (indexed(s.inputs) || indexed(s.outputs))) {
        throw bad("no entry has an index when a rule sets all_outputs");
    }
}

function inTxOrder(inputs: schema.Input[]): schema.Input[] {
    const out = [...inputs];
    if (out[0].index === undefined) return out;
    out.sort((a, b) => (a.index as number) - (b.index as number));
    if (out.some((x, i) => x.index !== i)) {
        throw bad(`input indexes must fill 0..${out.length - 1} once`);
    }
    return out;
}

// A taptree variable escapes the push size cap, so it fills nothing else.
function confineTaptrees(c: Compiler): void {
    for (const i of c.t.inputs) {
        const v = i.contract.taptree;
        if (v !== undefined && c.named.has(v)) {
            throw bad(`taptree variable ${q(v)} is used outside the taptree field`);
        }
    }
}
