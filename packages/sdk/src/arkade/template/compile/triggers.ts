import { hex } from "@scure/base";

import { HEX_TOKEN, isContextFree, PLACEHOLDER, serviceKey } from "../asm";
import { compareGo } from "../jcs";
import type * as schema from "../schema";
import { bad, type Compiler, checkExpression, inputIndex, q, within } from "./compiler";
import { type CaptureRule, contextFree, type Requirement, type Trigger, tokenName } from "./model";

const SERVICE_KEYS = ["SEALING_KEY", "OPERATOR_KEY", "EMULATOR_KEY"];
const OUTPUT_TAPTREE = "output:taptree";

export function triggers(c: Compiler): void {
    const rules = c.doc.delegation?.trigger;
    if (!rules?.size) return;
    if (!contextFree(c.t)) {
        throw bad("a trigger template is watched: its contract arguments must be context-free");
    }
    const names = [...rules.keys()].sort(compareGo);
    const rule = (name: string) => rules.get(name) as schema.Trigger;
    const captured = new Set<string>();
    for (const name of names) {
        for (const v of rule(name).capture.keys()) {
            if (captured.has(v)) throw bad(`variable ${q(v)} is captured twice`);
            captured.add(v);
        }
    }
    for (const name of names) {
        const s = rule(name);
        const prefix = `trigger of ${q(name)}`;
        const slot = inputIndex(c, name, "trigger");
        if (c.t.inputs[slot].onchain) throw bad(`${prefix}: a triggered input is offchain`);
        const tr: Trigger = {
            input: slot,
            packet: s.packet,
            raw: s.decode === "raw",
            records: s.decode === "records",
            minValue: s.minValue,
            require: [],
            captures: [],
            group: s.group,
            all: s.allOutputs,
            ttlSeconds: s.expiresAfter,
        };
        if (tr.group !== undefined && !isSource(tr, tr.group)) {
            throw bad(`${prefix}: group ${q(tr.group)} does not fit the rule`);
        }
        let fixed = false;
        for (const src of [...s.require.keys()].sort(compareGo)) {
            const r = within(prefix, () => requirement(c, tr, src, s.require.get(src) as string));
            fixed ||=
                r.key !== undefined ||
                r.lit !== undefined ||
                (r.variable !== undefined && !captured.has(r.variable));
            tr.require.push(r);
        }
        if (!fixed) throw bad(`${prefix}: no requirement is fixed before a transaction arrives`);
        for (const v of [...s.capture.keys()].sort(compareGo)) {
            tr.captures.push(within(prefix, () => capture(c, tr, v, s.capture.get(v) as string)));
        }
        c.t.triggers.push(tr);
    }
    c.t.triggers.sort((a, b) => a.input - b.input);
}

function requirement(c: Compiler, tr: Trigger, src: string, value: string): Requirement {
    if (!isSource(tr, src)) throw bad(`source ${q(src)} does not fit the rule`);
    const m = PLACEHOLDER.exec(value);
    if (HEX_TOKEN.test(value)) return { source: src, lit: hex.decode(value.slice(2)) };
    if (m && SERVICE_KEYS.includes(serviceKey(m[1]))) return { source: src, key: serviceKey(m[1]) };
    if (m) {
        if (!c.t.variables.has(m[1])) {
            throw bad(`require ${q(src)} names undeclared variable ${q(m[1])}`);
        }
        return { source: src, variable: m[1] };
    }
    return {
        source: src,
        expr: within(`require ${q(src)}`, () => triggerExpr(c, tr, value, true)),
    };
}

function capture(c: Compiler, tr: Trigger, v: string, value: string): CaptureRule {
    const type = c.t.variables.get(v);
    if (type === undefined) throw bad(`captures undeclared variable ${q(v)}`);
    if (value === OUTPUT_TAPTREE) {
        if (type !== "bytes") throw bad(`captures a taptree into ${type} variable ${q(v)}`);
        return { variable: v, type, source: value };
    }
    if (isSource(tr, value)) return { variable: v, type, source: value };
    const expr = within(`capture of ${q(v)}`, () => triggerExpr(c, tr, value, false));
    return { variable: v, type, expr };
}

// Evaluated against a dummy draft, so it may read only the rule's sources and, in a requirement,
// variables.
function triggerExpr(c: Compiler, tr: Trigger, value: string, variables: boolean): string[] {
    const body = value.startsWith("$(") && value.endsWith(")") ? value.slice(2, -1) : "";
    if (
        body === "" ||
        /[$()]/.test(body) ||
        body.startsWith(" ") ||
        body.endsWith(" ") ||
        body.includes("  ")
    ) {
        throw bad(`${q(value)} is not a literal, a key, a variable, a source or an expression`);
    }
    const expr = body.split(" ");
    for (const tok of expr) {
        if (!tok.startsWith("<")) continue;
        if (!tok.endsWith(">")) throw bad(`bad placeholder ${q(tok)}`);
        if (isSource(tr, tok.slice(1, -1))) continue;
        if (!variables) throw bad(`a capture expression names no variable: ${tok}`);
        if (!c.t.variables.has(tokenName(tok))) throw bad(`undeclared name ${q(tokenName(tok))}`);
    }
    checkExpression(c, expr);
    if (!isContextFree(expr)) throw bad(`trigger expression ${q(value)} is not context-free`);
    return expr;
}

function isSource(tr: Trigger, src: string): boolean {
    if (tr.raw) return src === "raw";
    const m = /^tlv:(0|[1-9][0-9]{0,2})$/.exec(src);
    return m !== null && Number(m[1]) <= 255;
}
