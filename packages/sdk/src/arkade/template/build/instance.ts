import { hex } from "@scure/base";
import { concatBytes } from "@scure/btc-signer/utils.js";

import { scriptFromTapLeafScript, type TapLeafScript } from "../../../script/base";
import { BigNum, type Opcode, ScriptTokenizer } from "../../vm";
import { decodeClosure } from "../../vm/closures";
import { flatten } from "../abi";
import { canonicalBytes, MAX_SCRIPT_NUM, parseScriptNum, type Value } from "../asm";
import {
    allOutputs,
    type ByteTemplate,
    type Construction,
    contextFree,
    type Input,
    isCLTV,
    isTaptree,
    type LockSpec,
    numberOrZero,
    type Output,
    outputIndex,
    type Template,
    type TemplateType,
    within,
} from "../compile";
import { buildContract, type Contract, type ContractKeys } from "../contract";
import { fail, wrap } from "../errors";
import { compareGo } from "../jcs";
import { type Action, buildCoins, type Fee } from "./build";
import {
    checkSources,
    checkSourceScript,
    type Draft,
    messageOf,
    newDraft,
    placeholder,
    type Source,
    type Src,
    toSrc,
} from "./draft";

export type Decrypt = (ciphertext: Uint8Array) => Uint8Array;

export interface Bindings {
    keys: ContractKeys;
    /** Canonical bytes per declared variable; sealed ones are ciphertexts when built with decrypt. */
    variables: Readonly<Record<string, Uint8Array>>;
}

export interface Context extends Bindings {
    /** Opens sealed variables; without it they are plaintexts already. */
    decrypt?: Decrypt;
    /** The coins of each input in turn; absent asks for a watch, built from the variables alone. */
    sources?: readonly Source[];
    /** Coins per input, one each when absent; only an all_outputs input holds several. */
    coins?: readonly number[];
}

export interface BuildRequest {
    sources: readonly Source[];
    coins?: readonly number[];
    fee: Fee;
    decrypt?: Decrypt;
}

interface Given {
    keys: ContractKeys;
    variables: ReadonlyMap<string, Uint8Array>;
    decrypt?: Decrypt;
    sources?: readonly (Src | undefined)[];
    coins?: readonly number[];
}

const LOCKTIME_THRESHOLD = 500_000_000;
const SEQ_DISABLED = 0x80000000;
const SEQ_SECONDS = 1 << 22;
const SEQ_MASK = 0xffff;
const MAX_UINT32 = 0xffffffff;
const q = JSON.stringify;
const EMPTY = new Uint8Array();

/** Holds no state derived from a particular source or plaintext. */
export class BoundTemplate {
    constructor(
        readonly template: Template,
        readonly keys: ContractKeys,
        readonly variables: ReadonlyMap<string, Uint8Array>,
    ) {}
}

export function bind(t: Template, b: Bindings): BoundTemplate {
    try {
        checkKeys(t, b.keys);
        const vars = variablesOf(b.variables);
        validateVariables(t, vars, true);
        const keys = {
            server: b.keys.server?.slice(),
            emulator: b.keys.emulator?.slice(),
            cosigner: b.keys.cosigner?.slice(),
        };
        return new BoundTemplate(t, keys, vars);
    } catch (e) {
        throw wrap("bind", e);
    }
}

/** Instantiates and builds in one step, so an instantiation failure reports stage "build". */
export function build(b: BoundTemplate, r: BuildRequest): Action {
    try {
        if (r.sources === undefined) throw fail("ineligible", "no sources");
        const sources = r.sources.map(toSrc);
        const { keys, variables } = b;
        const i = instantiateWith(b.template, {
            keys,
            variables,
            decrypt: r.decrypt,
            sources,
            coins: r.coins,
        });
        return buildCoins(i, sources, undefined, r.fee);
    } catch (e) {
        throw wrap("build", e);
    }
}

/** Without sources, derives the input contracts of a watch. */
export function instantiate(t: Template, c: Context): Instance {
    try {
        return instantiateWith(t, {
            ...c,
            variables: variablesOf(c.variables),
            sources: c.sources?.map(toSrc),
        });
    } catch (e) {
        throw wrap("instantiate", e);
    }
}

export class Instance {
    readonly contracts: Contract[] = [];
    readonly locktimes: (number | undefined)[] = [];
    readonly sequences: number[] = [];
    /** The transaction's nLockTime. */
    locktime = 0;

    constructor(
        readonly base: Template,
        readonly watch: boolean,
        readonly tmpl: Template,
        readonly keys: ContractKeys,
        readonly vars: ReadonlyMap<string, Uint8Array>,
    ) {}

    pkScript(slot: number): Uint8Array {
        return this.contracts[this.firstCoin(slot)].script.pkScript.slice();
    }

    tapscripts(slot: number): string[] {
        return this.contracts[this.firstCoin(slot)].script.scripts.map((s) => hex.encode(s));
    }

    build(sources: readonly Source[], fee: Fee): Action {
        return this.buildCoins(sources, undefined, fee);
    }

    /** Only a watch, whose contracts are the same for every coin, takes a new coin layout. */
    buildCoins(sources: readonly Source[], coins: readonly number[] | undefined, fee: Fee): Action {
        try {
            return buildCoins(this, sources.map(toSrc), coins, fee);
        } catch (e) {
            throw wrap("build", e);
        }
    }

    /** Refuses unless every spent leaf can be signed without the template's owner. */
    offlineSpend(directOnchain: boolean): void {
        try {
            for (const input of this.tmpl.inputs) offlineInput(input, directOnchain);
        } catch (e) {
            throw wrap("spend", e);
        }
    }

    firstCoin(slot: number): number {
        const g = this.tmpl.groups;
        return slot < 0 || slot >= g.length ? this.tmpl.inputs.length : g[slot][0];
    }

    relayout(coins: readonly number[]): Instance {
        if (!this.watch) throw fail("unsupported", "only a watch takes a new coin layout");
        const x = expand(this.base, coins);
        const j = new Instance(this.base, this.watch, x, this.keys, this.vars);
        j.locktime = this.locktime;
        x.groups.forEach((g, s) => {
            const k = this.firstCoin(s);
            for (const _ of g) {
                j.contracts.push(this.contracts[k]);
                j.locktimes.push(this.locktimes[k]);
                j.sequences.push(this.sequences[k]);
            }
        });
        return j;
    }

    /** The most one transaction may pay in fees; zero when it pays none. */
    feeCap(): bigint {
        const f = this.tmpl.fee;
        if (!f) return 0n;
        const n = f.maxVariable === undefined ? f.max : numberOrZero(this.value(f.maxVariable));
        return BigInt.asUintN(64, BigInt(n));
    }

    /** A non-canonical value is ineligible, unless watch, where only the variables supply it. */
    contractOf(c: Construction, d: Draft, slot: number, watch: boolean): Contract {
        const args: Record<string, Uint8Array> = Object.create(null);
        for (const f of flatten(c.def, c.def.constructorInputs)) {
            args[f.name] = within(`argument ${q(f.name)}`, () => {
                const raw = this.resolve(c.args.get(f.name) as ByteTemplate, d, d.index(slot));
                try {
                    canonicalBytes(f.type, raw);
                } catch (e) {
                    throw fail(watch ? "invalid_variables" : "ineligible", messageOf(e));
                }
                return raw;
            });
        }
        const taptree = c.taptree === undefined ? undefined : this.value(c.taptree).slice();
        return buildContract(c.def, args, this.keys, taptree);
    }

    resolve(b: ByteTemplate, d: Draft, input: number): Uint8Array {
        const lookup = (n: string) => this.lookup(n);
        const parts = b.map((p) => {
            if ("name" in p) return lookup(p.name).raw;
            if ("program" in p) {
                const o = this.tmpl.outputs[outputIndex(this.tmpl, p.program)];
                const ct = within(`output ${q(o.name)}`, () =>
                    this.contractOf(o.locking.contract as Construction, d, o.from, false),
                );
                return ct.script.pkScript.subarray(2);
            }
            if ("expr" in p) return d.evaluate(p.expr, input, lookup);
            return p.hex;
        });
        return concatBytes(...parts);
    }

    /** Evaluates b with slot as context input and requires the canonical bytes of typ. */
    decoded(b: ByteTemplate, typ: string, d: Draft, slot: number): Uint8Array {
        const raw = this.resolve(b, d, d.index(slot));
        try {
            canonicalBytes(typ, raw);
        } catch (e) {
            throw fail("ineligible", messageOf(e));
        }
        return raw;
    }

    private lookup(n: string): Value {
        const type = this.tmpl.variables.get(n);
        if (type === undefined) throw fail("invalid_template", `unknown name ${q(n)}`);
        return { type, raw: this.value(n) };
    }

    private value(n: string): Uint8Array {
        return this.vars.get(n) ?? EMPTY;
    }

    // range checked with the variables
    private lockValue(l: LockSpec): number {
        return (l.variable === undefined ? l.n : numberOrZero(this.value(l.variable))) >>> 0;
    }

    /** nLockTime and every nSequence: a stated value, or the one the spent leaf asks for. */
    resolveLocks(csvs: readonly (number | undefined)[]): void {
        const t = this.tmpl;
        for (const lt of this.locktimes)
            if (lt !== undefined) this.locktime = Math.max(this.locktime, lt);
        if (t.locktime) {
            const n = this.lockValue(t.locktime);
            const seconds = (x: number) => x >= LOCKTIME_THRESHOLD;
            if (n < this.locktime || (this.locktime > 0 && seconds(n) !== seconds(this.locktime))) {
                throw fail("ineligible", `locktime ${n} is not accepted by the spent leaves`);
            }
            this.locktime = n;
        }
        t.inputs.forEach((input, slot) => {
            let seq = this.locktime > 0 ? MAX_UINT32 - 1 : MAX_UINT32;
            const csv = csvs[slot];
            if (csv !== undefined && t.type !== "virtual") seq = csv;
            if (input.sequence) {
                seq = this.lockValue(input.sequence);
                if (csv !== undefined && !acceptsCSV(seq, csv)) {
                    throw fail(
                        "ineligible",
                        `input ${q(input.name)}: sequence ${seq} is not accepted by its leaf`,
                    );
                }
            }
            this.sequences.push(seq);
        });
    }
}

function instantiateWith(t: Template, c: Given): Instance {
    const vars = open(t, c.variables, c.decrypt);
    validateVariables(t, vars, false);
    const watch = c.sources === undefined;
    const x = expand(t, watch ? undefined : c.coins);
    let sources: readonly (Src | undefined)[];
    if (watch) {
        if (!contextFree(t)) {
            throw fail("unsupported", "a watch needs context-free contract arguments");
        }
        sources = x.inputs.map(placeholder);
    } else {
        sources = c.sources as readonly (Src | undefined)[];
        checkSources(sources, x.inputs.length);
    }
    const d = newDraft(t.type, sources as readonly Src[]);
    d.contextFree = watch;
    const copies = new Map([...vars].map(([n, v]) => [n, v.slice()]));
    const i = new Instance(t, watch, x, c.keys, copies);
    const csvs: (number | undefined)[] = [];
    x.inputs.forEach((input, slot) => {
        const ct = within(`input ${q(input.name)}`, () =>
            i.contractOf(input.contract, d, slot, watch),
        );
        const script = scriptFromTapLeafScript(leafOf(ct, input));
        const { cltv, csv } = leafLocks(script);
        i.locktimes.push(checkClosure(input, script, t.type) ?? cltv);
        csvs.push(csv);
        if (!watch) checkSourceScript(input, sources[slot] as Src, ct);
        i.contracts.push(ct);
    });
    if (!sameDomain(i.locktimes)) {
        throw fail("unsupported", "locktimes mix block heights and timestamps");
    }
    i.resolveLocks(csvs);
    return i;
}

export const leafOf = (ct: Contract, input: Input): TapLeafScript =>
    ct.proofs.get(input.function)?.get(input.leaf) as TapLeafScript;

function variablesOf(given: Readonly<Record<string, Uint8Array>>): Map<string, Uint8Array> {
    return new Map(Object.entries(given).map(([n, v]) => [n, v.slice()]));
}

function checkKeys(t: Template, keys: ContractKeys): void {
    const r = t.requiredKeys;
    if (r.server && !keys.server) throw fail("unsupported", "missing server key");
    if (r.emulator && !keys.emulator) throw fail("unsupported", "missing emulator key");
    if (r.cosigner && !keys.cosigner) throw fail("unsupported", "missing cosigner key");
}

/** Without decrypt, sealed values are plaintexts already. */
function open(
    t: Template,
    vars: ReadonlyMap<string, Uint8Array>,
    decrypt: Decrypt | undefined,
): ReadonlyMap<string, Uint8Array> {
    if (!decrypt || t.sealed.size === 0) return vars;
    const out = new Map(vars);
    for (const n of [...t.sealed].sort(compareGo)) {
        const ct = vars.get(n);
        if (ct === undefined) continue;
        try {
            const p = decrypt(ct);
            canonicalBytes(t.variables.get(n) as string, p);
            out.set(n, p);
        } catch (e) {
            throw fail("ineligible", `sealed ${q(n)}: ${messageOf(e)}`);
        }
    }
    return out;
}

function validateVariables(
    t: Template,
    vars: ReadonlyMap<string, Uint8Array>,
    skipSealed: boolean,
): void {
    if (vars.size !== t.variables.size) {
        throw fail("invalid_variables", `${vars.size} values for ${t.variables.size} variables`);
    }
    for (const n of [...t.variables.keys()].sort(compareGo)) {
        const v = vars.get(n);
        if (v === undefined) throw fail("invalid_variables", `missing ${q(n)}`);
        if (isTaptree(t, n) || (skipSealed && t.sealed.has(n))) continue;
        try {
            canonicalBytes(t.variables.get(n) as string, v);
        } catch (e) {
            throw fail("invalid_variables", `variable ${q(n)}: ${messageOf(e)}`);
        }
    }
    const check = (name: string, lo: number, hi: number) => {
        if (skipSealed && t.sealed.has(name)) return;
        let n: number | undefined;
        try {
            n = parseScriptNum(vars.get(name) ?? EMPTY);
        } catch {
            n = undefined;
        }
        if (n === undefined || n < lo || n > hi) {
            throw fail("invalid_variables", `${q(name)} must be in ${lo}..${hi}`);
        }
    };
    for (const input of t.inputs) if (input.leadVariable) check(input.leadVariable, 1, MAX_UINT32);
    for (const l of [t.locktime, ...t.inputs.map((i) => i.sequence)]) {
        if (l?.variable !== undefined) check(l.variable, 0, MAX_UINT32);
    }
    if (t.fee?.maxVariable !== undefined) check(t.fee.maxVariable, 0, MAX_SCRIPT_NUM);
}

/** Lays out an instance: an input becomes a slot per coin, an each output a copy per coin. */
export function expand(t: Template, counts?: readonly number[]): Template {
    if (counts && counts.length !== t.inputs.length) {
        throw fail("ineligible", `${counts.length} coin counts for ${t.inputs.length} inputs`);
    }
    const inputs: Input[] = [];
    const groups: number[][] = t.inputs.map(() => []);
    t.inputs.forEach((input, s) => {
        const n = counts ? counts[s] : 1;
        if (!Number.isInteger(n) || n < 1 || (n > 1 && !allOutputs(t, s))) {
            throw fail("ineligible", `input ${q(input.name)} cannot hold ${n} coins`);
        }
        for (let k = 0; k < n; k++) {
            groups[s].push(inputs.length);
            inputs.push(input);
        }
    });
    // other references to an input name its first coin
    const first = (s: number) => (s < 0 ? s : groups[s][0]);
    const outputs: Output[] = [];
    const copies: number[][] = t.outputs.map(() => []);
    t.outputs.forEach((o, k) => {
        for (const coin of o.each >= 0 ? groups[o.each] : [-1]) {
            const to = (s: number) => (coin >= 0 && s === o.each ? coin : first(s));
            copies[k].push(outputs.length);
            outputs.push({
                ...o,
                coin,
                from: to(o.from),
                locking: { ...o.locking, from: to(o.locking.from) },
                draws: o.draws.map((d) => ({ ...d, from: to(d.from) })),
                assets: o.assets.map((r) => ({ ...r, from: to(r.from) })),
            });
        }
    });
    if (inputs.length !== t.inputs.length || outputs.length !== t.outputs.length) {
        outputs.forEach((o, k) => (o.index = k)); // all_outputs leaves no index
    }
    const x: Template = {
        ...t,
        inputs,
        outputs,
        groups,
        burns: t.burns.map((b) => ({ ...b, from: first(b.from) })),
    };
    if (t.fee) x.fee = { ...t.fee, from: first(t.fee.from) };
    if (t.packets) {
        x.packets = {
            ...t.packets,
            rules: t.packets.rules.map((r) => ({ ...r, from: first(r.from) })),
            adverts: t.packets.adverts.map((ad) => ({
                ...ad,
                outputs: ad.outputs.flatMap((k) => copies[k]),
            })),
        };
    }
    return x;
}

// txscript.MakeScriptNum(v, true, max) over int64
function scriptNum(v: Uint8Array, max: number): bigint | undefined {
    if (v.length > max) return undefined;
    try {
        return BigNum.fromBytes(v).value;
    } catch {
        return undefined;
    }
}

const isSmallInt = (op: number) => op === 0x00 || (op >= 0x51 && op <= 0x60);
const smallInt = (op: number) => (op === 0x00 ? 0 : op - 0x50);

/** The highest pushed value before each OP_CHECKLOCKTIMEVERIFY and OP_CHECKSEQUENCEVERIFY. */
export function leafLocks(script: Uint8Array): { cltv?: number; csv?: number } {
    const out: { cltv?: number; csv?: number } = {};
    const t = new ScriptTokenizer(script);
    let prevOp = 0x00;
    let prev: Uint8Array = EMPTY;
    while (t.next()) {
        const op = (t.op as Opcode).value;
        if (op === 0xb1 || op === 0xb2) {
            const k = op === 0xb2 ? "csv" : "cltv";
            // the predecessor is not checked to be a push: any other opcode reads as 0
            const n =
                prevOp >= 0x51 && prevOp <= 0x60 ? BigInt(smallInt(prevOp)) : scriptNum(prev, 5);
            const was = out[k];
            if (n !== undefined && n >= 0n && n <= BigInt(MAX_UINT32)) {
                if (was === undefined || Number(n) > was) out[k] = Number(n);
            }
        }
        prevOp = op;
        prev = t.data;
    }
    return out;
}

/**
 * A virtual spend leaf's absolute locktime. The emulator accepts only ark-lib closures on a leaf
 * naming its key, and arkd builds a locktime only from a CLTV multisig.
 */
function checkClosure(input: Input, script: Uint8Array, type: TemplateType): number | undefined {
    const asm = input.selectedLeaf.asm;
    const emulated = asm.some(
        (tok) => tok.startsWith("<EMULATOR_KEY:") || tok.startsWith("<TWEAK:"),
    );
    const cltv = type === "virtual" && asm.some(isCLTV);
    if (!emulated && !cltv) return undefined;
    let closure = true;
    try {
        decodeClosure(script);
    } catch {
        closure = false;
    }
    const lock = closure ? cltvLocktime(script) : undefined;
    const where = `input ${q(input.name)}: leaf ${q(input.leaf)}`;
    if (cltv && lock === undefined) {
        throw fail("unsupported", `${where} is not a CLTV multisig closure`);
    }
    if (!closure) throw fail("unsupported", `${where} is not a closure`);
    return cltv ? lock : undefined;
}

// With this prefix no other ark-lib closure decodes, so an accepted script is a CLTV multisig.
function cltvLocktime(script: Uint8Array): number | undefined {
    const t = new ScriptTokenizer(script);
    if (!t.next()) return undefined;
    const op = (t.op as Opcode).value;
    let n: number;
    if (isSmallInt(op)) {
        n = smallInt(op);
    } else if (op >= 0x01 && op <= 0x4e) {
        const v = scriptNum(t.data, 6);
        if (v === undefined || v < 0n || v > BigInt(MAX_UINT32) || (v > 0n && v <= 16n)) {
            return undefined;
        }
        n = Number(v);
    } else {
        return undefined;
    }
    for (const want of [0xb1, 0x75]) {
        if (!t.next() || (t.op as Opcode).value !== want) return undefined;
    }
    return n;
}

function sameDomain(lts: readonly (number | undefined)[]): boolean {
    const defined = lts.filter((lt) => lt !== undefined);
    return defined.every((lt) => lt >= LOCKTIME_THRESHOLD === defined[0] >= LOCKTIME_THRESHOLD);
}

/** BIP 112: whether nSequence seq satisfies <req> OP_CHECKSEQUENCEVERIFY. */
function acceptsCSV(seq: number, req: number): boolean {
    if ((req & SEQ_DISABLED) !== 0) return true;
    return (
        (seq & SEQ_DISABLED) === 0 &&
        (seq & SEQ_SECONDS) === (req & SEQ_SECONDS) &&
        (seq & SEQ_MASK) >= (req & SEQ_MASK)
    );
}

function offlineInput(input: Input, directOnchain: boolean): void {
    const leaf = input.selectedLeaf;
    for (const w of leaf.witness) {
        if (w.type === "signature" && !w.injected) {
            throw fail(
                "unsupported",
                `input ${q(input.name)}: leaf ${q(leaf.name)} needs signature ${q(w.name)}, which nobody injects`,
            );
        }
    }
    leaf.asm.forEach((tok, n) => {
        if (!["OP_CHECKSIG", "OP_CHECKSIGVERIFY", "OP_CHECKSIGADD"].includes(tok)) return;
        if (n === 0) throw fail("unsupported", `input ${q(input.name)}: checksig has no key`);
        const key = leaf.asm[n - 1];
        const emulator = key.startsWith("<EMULATOR_KEY:") && key.endsWith(">");
        const server = key === "<SERVER_KEY>";
        if ((directOnchain && emulator) || (!directOnchain && (server || emulator))) return;
        throw fail("unsupported", `input ${q(input.name)}: signer ${key} is not available offline`);
    });
}
