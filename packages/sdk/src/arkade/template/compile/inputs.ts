import { type Definition, flatten } from "../abi";
import { fail } from "../errors";
import { compareGo } from "../jcs";
import type * as schema from "../schema";
import {
    bad,
    bind,
    type Compiler,
    inputIndex,
    intVariable,
    q,
    scriptBind,
    slotType,
} from "./compiler";
import type { ByteTemplate, Construction, LockSpec, Schedule } from "./model";

export const isCLTV = (tok: string) => tok === "OP_CHECKLOCKTIMEVERIFY" || tok === "OP_NOP2";

export function input(c: Compiler, s: schema.Input): void {
    if (c.t.inputs.some((o) => o.name === s.name)) throw bad(`duplicate input ${q(s.name)}`);
    const onchain = slotType(c, s.type);
    const contract = construction(c, s.contract);
    c.t.inputs.push({
        name: s.name,
        onchain,
        schedule: { beforeExpirySeconds: 0, minConfirmations: 0 },
        contract,
        ...spend(c, contract, s.spend),
    });
}

export function construction(c: Compiler, s: schema.Construction): Construction {
    const def = definition(c, s.definition);
    requireKeys(c, def);
    const flat = flatten(def, def.constructorInputs);
    const ct: Construction = { def, args: new Map() };
    if (s.taptree !== undefined) {
        const name = s.taptree.slice(1, -1);
        if (c.t.variables.get(name) !== "bytes") {
            throw bad(`taptree must name a bytes variable, got ${q(s.taptree)}`);
        }
        ct.taptree = name;
    }
    for (const f of flat) {
        const raw = s.arguments?.get(f.name);
        if (raw === undefined) throw bad(`missing argument ${q(f.name)}`);
        if ("program" in raw) {
            if (f.type !== "bytes32") {
                throw bad(`output program ${q(raw.program)} cannot fill a ${f.type} field`);
            }
            // Go's piece with an empty program has no field set, so it reads as an empty literal.
            ct.args.set(f.name, [
                raw.program ? { program: raw.program } : { hex: new Uint8Array() },
            ]);
            continue;
        }
        ct.args.set(f.name, scriptBind(c, raw, f.type));
    }
    if ((s.arguments?.size ?? 0) !== flat.length) {
        throw bad(`contract ${q(def.contractName)} has arguments outside its constructor`);
    }
    return ct;
}

// The whole tree is built, so unselected leaves count too.
function requireKeys(c: Compiler, def: Definition): void {
    const keys = c.t.requiredKeys;
    for (const fn of def.functions) {
        for (const tokens of [fn.arkade?.asm ?? [], ...fn.leaves.map((l) => l.asm)]) {
            for (const tok of tokens) {
                if (tok === "<SERVER_KEY>") keys.server = true;
                else if (tok === "<COSIGNER_KEY>") keys.cosigner = true;
                else if (tok.startsWith("<EMULATOR_KEY:")) keys.emulator = true;
            }
        }
    }
}

// The artifact/v1 profile check of Go's definition() is omitted: a decoded artifact has no other.
function definition(c: Compiler, ref: schema.DefinitionRef): Definition {
    if ("def" in ref) return ref.def;
    const id = ref.artifact;
    const known = c.definitions.get(id);
    if (known) return known;
    const a = c.artifacts.get(id);
    if (!a) throw bad(`artifact ${id} not provided`);
    if (a.id !== id) throw bad(`artifact ${id} resolves to a document with id ${a.id}`);
    c.definitions.set(id, a.definition);
    c.t.artifacts.push(id);
    return a.definition;
}

function spend(c: Compiler, ct: Construction, s: schema.Spend) {
    const f = ct.def.functions.find((x) => x.name === s.function);
    if (!f) throw bad(`unknown function ${q(s.function)}`);
    const l = f.leaves.find((x) => x.name === s.leaf);
    if (!l) throw bad(`unknown leaf ${q(s.leaf)}`);
    if (l.asm.some(isCLTV) && c.t.type === "proof") {
        throw fail(
            "unsupported",
            `leaf ${q(l.name)} needs an absolute locktime, which a proof does not set`,
        );
    }
    const want = f.arkade ? flatten(ct.def, f.arkade.inputs) : [];
    const given = s.arguments ?? [];
    if (given.length !== want.length) {
        throw bad(`function ${q(f.name)} takes ${want.length} arguments, got ${given.length}`);
    }
    const args = given.map((a, i) => bind(c, a, want[i].type));
    const witness = new Map<string, ByteTemplate>();
    for (const w of l.witness) {
        if (w.type === "signature") {
            if (!w.injected) {
                throw bad(`leaf ${q(l.name)} needs signature ${q(w.name)}, which nobody injects`);
            }
            continue;
        }
        const raw = s.witness?.get(w.name);
        if (raw === undefined) throw bad(`witness item ${q(w.name)} is not bound`);
        witness.set(w.name, bind(c, raw, w.type));
    }
    if ((s.witness?.size ?? 0) !== witness.size) {
        throw bad(`spend binds witness items that are signatures or absent from leaf ${q(l.name)}`);
    }
    return {
        function: f.name,
        leaf: l.name,
        selected: f,
        selectedLeaf: l,
        arguments: args,
        witness,
    };
}

export function schedules(c: Compiler): void {
    const s = c.doc.delegation?.schedule;
    for (const n of [...(s?.keys() ?? [])].sort(compareGo)) {
        const i = c.t.inputs[inputIndex(c, n, "schedule")];
        const { schedule, lead } = scheduleOf(c, s?.get(n) as schema.Schedule, i.onchain);
        i.schedule = schedule;
        i.leadVariable = lead;
    }
}

function scheduleOf(
    c: Compiler,
    s: schema.Schedule,
    onchain: boolean,
): { schedule: Schedule; lead?: string } {
    const none = { beforeExpirySeconds: 0, minConfirmations: 0 };
    if (s.immediate !== undefined) return { schedule: none };
    if (s.beforeExpiry !== undefined && !onchain) {
        const { n, variable } = intVariable(c, s.beforeExpiry);
        if (variable !== undefined) return { schedule: none, lead: variable };
        return { schedule: { ...none, beforeExpirySeconds: n } };
    }
    if (s.minConfirmations !== undefined && onchain) {
        return { schedule: { ...none, minConfirmations: s.minConfirmations } };
    }
    throw bad("the schedule does not fit the input");
}

/** arkd derives both for a virtual spend, and a proof carries no locktime. */
export function locks(c: Compiler): void {
    const spec = (v: schema.IntOrVar | undefined, what: string): LockSpec | undefined => {
        if (v === undefined) return undefined;
        if (c.t.type === "virtual" || (c.t.type === "proof" && what === "locktime")) {
            throw fail("unsupported", `${what} in a ${c.t.type} template`);
        }
        return intVariable(c, v);
    };
    c.t.locktime = spec(c.doc.locktime, "locktime");
    for (const s of c.doc.inputs) {
        c.t.inputs[inputIndex(c, s.name, "sequence")].sequence = spec(s.sequence, "sequence");
    }
}

export function fees(c: Compiler): void {
    const s = c.doc.fees;
    if (!s) return;
    if (c.t.type === "virtual") throw bad("an offchain template has no fees");
    const from = inputIndex(c, s.from, "fees");
    const { n, variable } = intVariable(c, s.max);
    c.t.fee = { from, max: n, maxVariable: variable };
}
