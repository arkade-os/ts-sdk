import { canonicalDefinition, type Definition, parseDefinition, SCALAR_TYPES } from "./abi";
import { Failure } from "./errors";
import {
    checkNumbers,
    compareGo,
    JcsError,
    JsonNumber,
    type JsonObject,
    type JsonValue,
} from "./jcs";

export type Binding = { int: number } | { bool: boolean } | { str: string } | { program: string };
export type IntOrVar = { int: number } | { var: string };
export type Locking = { script: string } | { from: string } | { contract: Construction };
export type DefinitionRef = { artifact: string } | { def: Definition };
export type Control = { asset: string } | { issue: string };

export interface Template {
    format: string;
    type: string;
    variables?: Map<string, string>;
    inputs: Input[];
    outputs: Output[];
    fees?: Fees;
    issues?: Issue[];
    burns?: AssetRoute[];
    locktime?: IntOrVar;
    packets?: Packets;
    delegation?: Delegation;
}

export interface Delegation {
    schedule?: Map<string, Schedule>;
    sealed?: Sealed[];
    trigger?: Map<string, Trigger>;
}

export interface Sealed {
    name: string;
    scheme?: string;
}

export interface Input {
    name: string;
    type?: string;
    index?: number;
    sequence?: IntOrVar;
    contract: Construction;
    spend: Spend;
}

export interface Schedule {
    immediate?: boolean;
    beforeExpiry?: IntOrVar;
    minConfirmations?: number;
}

export interface Construction {
    definition: DefinitionRef;
    arguments?: Map<string, Binding>;
    taptree?: string;
}

export interface Spend {
    function: string;
    leaf: string;
    arguments?: Binding[];
    witness?: Map<string, Binding>;
}

export interface Output {
    name: string;
    type?: string;
    index?: number;
    each?: string;
    value: Value;
    locking: Locking;
    assets?: AssetRoute[];
}

export interface Value {
    draws: Draw[];
    list: boolean;
}

export interface Draw {
    from: string;
    amount?: Binding;
}

export interface AssetRoute {
    from?: string;
    issue?: string;
    asset?: string;
    amount?: Binding;
}

export interface Issue {
    name: string;
    asset?: string;
    control?: Control;
    metadata?: Map<string, string>;
}

export interface Fees {
    from: string;
    max: IntOrVar;
}

export interface Packets {
    outputIndex?: number;
    unmatched?: string;
    rules?: Rule[];
    advertise?: Advert[];
}

export interface Rule {
    type: number;
    action: string;
    from: string;
    data?: Binding;
}

export interface Advert {
    template: string;
    outputs: string[];
}

export interface Trigger {
    packet: number;
    decode?: string;
    minValue: number;
    allOutputs: boolean;
    require: Map<string, string>;
    capture: Map<string, string>;
    group?: string;
    expiresAfter: number;
}

export const FORMAT = "template/v1";
export const NAME = /^[a-z][a-z0-9_]*$/;
const ID_HEX = /^[0-9a-f]{64}$/;
const NAMED_VAR = /^<([a-z][a-z0-9_]*)>$/;
const TYPES = ["proof", "virtual", "onchain"];
const SLOT_TYPES = ["offchain", "onchain"];
const ACTIONS = ["copy", "drop", "emit"];
const UNMATCHEDS = ["reject", "drop"];
const DECODES = ["tlv", "records", "raw"];
const MAX_UINT32 = 0xffffffff;
// Go bounds these by MaxInt64; a decoded integer never exceeds 2^53-1, so the checks agree.
const MAX = Number.MAX_SAFE_INTEGER;

type Read<T> = (v: JsonValue, path: string) => T;

const q = JSON.stringify;
const bad = (message: string, path?: string) => new Failure(["invalid_template"], message, path);
const child = (path: string, key: string) =>
    `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
const sortedKeys = (m?: Map<string, unknown>) => (m ? [...m.keys()].sort(compareGo) : []);

/** Strict typed read, then the syntactic rules; numbers are judged before any field. */
export function decodeValue(v: JsonValue): Template {
    try {
        checkNumbers(v);
    } catch (e) {
        if (e instanceof JcsError) throw bad(e.message);
        throw e;
    }
    const t = readTemplate(v, "");
    checkTemplate(t);
    return t;
}

function reader(v: JsonValue, path: string, keys: readonly string[]) {
    if (!(v instanceof Map)) throw bad(`${path} must be an object`, path);
    for (const k of sortedKeys(v)) {
        if (!keys.includes(k)) throw bad(`${path} has unknown field ${q(k)}`, child(path, k));
    }
    const opt = <T>(key: string, read: Read<T>): T | undefined => {
        if (!v.has(key)) return undefined;
        const p = child(path, key);
        const x = v.get(key) as JsonValue;
        if (x === null) throw bad(`${p} is null`, p);
        return read(x, p);
    };
    const req = <T>(key: string, read: Read<T>): T => {
        if (!v.has(key)) throw bad(`${path} misses ${q(key)}`, child(path, key));
        return opt(key, read) as T;
    };
    return { opt, req };
}

// The single-key objects of a binding or an artifact reference check presence before strays.
function exact(m: JsonObject, path: string, key: string): void {
    if (!m.has(key)) throw bad(`${path} misses ${q(key)}`, path);
    for (const k of sortedKeys(m)) {
        if (k !== key) throw bad(`${path} has unknown field ${q(k)}`, path);
    }
}

const readString: Read<string> = (v, path) => {
    if (typeof v !== "string" || v === "") throw bad(`${path} must be a non-empty string`, path);
    return v;
};

const readBool: Read<boolean> = (v, path) => {
    if (typeof v !== "boolean") throw bad(`${path} must be a boolean`, path);
    return v;
};

const readTrue: Read<boolean> = (v, path) => {
    if (v !== true) throw bad(`${path} must be true`, path);
    return v;
};

const readInt: Read<number> = (v, path) => {
    if (!(v instanceof JsonNumber)) throw bad(`${path} must be an integer`, path);
    return Number(v.text);
};

const list =
    <T>(read: Read<T>): Read<T[]> =>
    (v, path) => {
        if (!Array.isArray(v)) throw bad(`${path} must be an array`, path);
        return v.map((e, i) => read(e, child(path, String(i))));
    };

const dictionary =
    <T>(read: Read<T>): Read<Map<string, T>> =>
    (v, path) => {
        if (!(v instanceof Map)) throw bad(`${path} must be an object`, path);
        const out = new Map<string, T>();
        for (const k of sortedKeys(v)) {
            const p = child(path, k);
            const x = v.get(k) as JsonValue;
            if (x === null) throw bad(`${p} is null`, p);
            out.set(k, read(x, p));
        }
        return out;
    };

const readBinding: Read<Binding> = (v, path) => {
    if (v instanceof JsonNumber) return { int: Number(v.text) };
    if (typeof v === "boolean") return { bool: v };
    if (typeof v === "string") return { str: v };
    if (v instanceof Map) {
        exact(v, path, "program");
        const program = v.get("program");
        if (typeof program !== "string") throw bad(`${path}.program must be a string`, path);
        return { program };
    }
    throw bad(`${path}: binding must be an integer, boolean, string or program reference`, path);
};

const readIntOrVar: Read<IntOrVar> = (v, path) => {
    if (v instanceof JsonNumber) return { int: Number(v.text) };
    if (typeof v !== "string") throw bad(`${path} must be an integer or an int variable`, path);
    const m = NAMED_VAR.exec(v);
    if (!m) throw bad(`${path}: ${q(v)} is not an int variable`, path);
    return { var: m[1] };
};

const readLocking: Read<Locking> = (v, path) => {
    if (typeof v === "string") return { script: v };
    if (!(v instanceof Map)) throw bad(`${path} must be a string or an object`, path);
    if (v.size !== 1 || !(v.has("from") || v.has("contract"))) {
        throw bad(`${path} has exactly one of from and contract`, path);
    }
    if (v.has("from")) {
        const from = v.get("from");
        if (typeof from !== "string") throw bad(`${path}.from must be a string`, path);
        return { from };
    }
    return { contract: readConstruction(v.get("contract") as JsonValue, child(path, "contract")) };
};

const readDefinitionRef: Read<DefinitionRef> = (v, path) => {
    if (v instanceof Map && v.has("artifact")) {
        exact(v, path, "artifact");
        const id = v.get("artifact");
        if (typeof id !== "string" || !ID_HEX.test(id)) throw bad(`${path}: bad artifact id`, path);
        return { artifact: id };
    }
    try {
        return { def: parseDefinition(v) };
    } catch (e) {
        if (e instanceof Failure) e.path ??= path;
        throw e;
    }
};

function readTemplate(v: JsonValue, path: string): Template {
    const r = reader(v, path, [
        "format",
        "type",
        "variables",
        "inputs",
        "outputs",
        "fees",
        "issues",
        "burns",
        "locktime",
        "packets",
        "delegation",
    ]);
    return {
        format: r.req("format", readString),
        type: r.req("type", readString),
        variables: r.opt("variables", dictionary(readString)),
        inputs: r.req("inputs", list(readInput)),
        outputs: r.req("outputs", list(readOutput)),
        fees: r.opt("fees", readFees),
        issues: r.opt("issues", list(readIssue)),
        burns: r.opt("burns", list(readAssetRoute)),
        locktime: r.opt("locktime", readIntOrVar),
        packets: r.opt("packets", readPackets),
        delegation: r.opt("delegation", readDelegation),
    };
}

const readDelegation: Read<Delegation> = (v, path) => {
    const r = reader(v, path, ["schedule", "sealed", "trigger"]);
    return {
        schedule: r.opt("schedule", dictionary(readSchedule)),
        sealed: r.opt("sealed", list(readSealed)),
        trigger: r.opt("trigger", dictionary(readTrigger)),
    };
};

const readInput: Read<Input> = (v, path) => {
    const r = reader(v, path, ["name", "type", "index", "sequence", "contract", "spend"]);
    return {
        name: r.req("name", readString),
        type: r.opt("type", readString),
        index: r.opt("index", readInt),
        sequence: r.opt("sequence", readIntOrVar),
        contract: r.req("contract", readConstruction),
        spend: r.req("spend", readSpend),
    };
};

const readSchedule: Read<Schedule> = (v, path) => {
    const r = reader(v, path, ["immediate", "before_expiry_seconds", "min_confirmations"]);
    return {
        immediate: r.opt("immediate", readBool),
        beforeExpiry: r.opt("before_expiry_seconds", readIntOrVar),
        minConfirmations: r.opt("min_confirmations", readInt),
    };
};

const readConstruction: Read<Construction> = (v, path) => {
    const r = reader(v, path, ["definition", "arguments", "taptree"]);
    return {
        definition: r.req("definition", readDefinitionRef),
        arguments: r.opt("arguments", dictionary(readBinding)),
        taptree: r.opt("taptree", readString),
    };
};

const readSpend: Read<Spend> = (v, path) => {
    const r = reader(v, path, ["function", "leaf", "arguments", "witness"]);
    return {
        function: r.req("function", readString),
        leaf: r.req("leaf", readString),
        arguments: r.opt("arguments", list(readBinding)),
        witness: r.opt("witness", dictionary(readBinding)),
    };
};

const readOutput: Read<Output> = (v, path) => {
    const r = reader(v, path, ["name", "type", "index", "each", "value", "locking", "assets"]);
    return {
        name: r.req("name", readString),
        type: r.opt("type", readString),
        index: r.opt("index", readInt),
        each: r.opt("each", readString),
        value: r.req("value", readValue),
        locking: r.req("locking", readLocking),
        assets: r.opt("assets", list(readAssetRoute)),
    };
};

const readValue: Read<Value> = (v, path) =>
    Array.isArray(v)
        ? { draws: list(readDraw)(v, path), list: true }
        : { draws: [readDraw(v, path)], list: false };

const readDraw: Read<Draw> = (v, path) => {
    const r = reader(v, path, ["from", "amount"]);
    return { from: r.req("from", readString), amount: r.opt("amount", readBinding) };
};

const readAssetRoute: Read<AssetRoute> = (v, path) => {
    const r = reader(v, path, ["from", "issue", "asset", "amount"]);
    return {
        from: r.opt("from", readString),
        issue: r.opt("issue", readString),
        asset: r.opt("asset", readString),
        amount: r.opt("amount", readBinding),
    };
};

const readIssue: Read<Issue> = (v, path) => {
    const r = reader(v, path, ["name", "asset", "control", "metadata"]);
    return {
        name: r.req("name", readString),
        asset: r.opt("asset", readString),
        control: r.opt("control", readControl),
        metadata: r.opt("metadata", dictionary(readString)),
    };
};

const readControl: Read<Control> = (v, path) => {
    if (typeof v === "string") return { asset: v };
    return { issue: reader(v, path, ["issue"]).req("issue", readString) };
};

const readSealed: Read<Sealed> = (v, path) => {
    if (typeof v === "string") return { name: v };
    const r = reader(v, path, ["name", "scheme"]);
    return { name: r.req("name", readString), scheme: r.req("scheme", readString) };
};

const readFees: Read<Fees> = (v, path) => {
    const r = reader(v, path, ["from", "max"]);
    return { from: r.req("from", readString), max: r.req("max", readIntOrVar) };
};

const readPackets: Read<Packets> = (v, path) => {
    const r = reader(v, path, ["output_index", "unmatched", "rules", "advertise"]);
    return {
        outputIndex: r.opt("output_index", readInt),
        unmatched: r.opt("unmatched", readString),
        rules: r.opt("rules", list(readRule)),
        advertise: r.opt("advertise", list(readAdvert)),
    };
};

const readRule: Read<Rule> = (v, path) => {
    const r = reader(v, path, ["type", "action", "from", "data"]);
    return {
        type: r.req("type", readInt),
        action: r.req("action", readString),
        from: r.req("from", readString),
        data: r.opt("data", readBinding),
    };
};

const readAdvert: Read<Advert> = (v, path) => {
    const r = reader(v, path, ["template", "outputs"]);
    return { template: r.req("template", readString), outputs: r.req("outputs", list(readString)) };
};

const readTrigger: Read<Trigger> = (v, path) => {
    const r = reader(v, path, [
        "packet",
        "decode",
        "require",
        "capture",
        "group",
        "expires_after_seconds",
        "min_value",
        "all_outputs",
    ]);
    return {
        packet: r.req("packet", readInt),
        decode: r.opt("decode", readString),
        allOutputs: r.opt("all_outputs", readTrue) ?? false,
        require: r.req("require", dictionary(readString)),
        capture: r.req("capture", dictionary(readString)),
        group: r.opt("group", readString),
        expiresAfter: r.req("expires_after_seconds", readInt),
        minValue: r.opt("min_value", readInt) ?? 0,
    };
};

function integer(n: number, what: string, lo: number, hi: number): void {
    if (n < lo || n > hi) throw bad(`${what} must be an integer in ${lo}..${hi}, got ${n}`);
}

function checkIntOrVar(iv: IntOrVar | undefined, what: string, lo: number, hi: number): void {
    if (iv && "int" in iv) integer(iv.int, what, lo, hi);
}

function checkTemplate(t: Template): void {
    if (t.format !== FORMAT) throw bad(`format must be ${q(FORMAT)}`);
    if (!TYPES.includes(t.type)) throw bad(`unknown type ${q(t.type)}`);
    for (const n of sortedKeys(t.variables)) {
        const typ = t.variables?.get(n) as string;
        if (!NAME.test(n)) throw bad(`bad variable name ${q(n)}`);
        if (!SCALAR_TYPES.includes(typ))
            throw bad(`variable ${q(n)} has unsupported type ${q(typ)}`);
    }
    if (t.inputs.length === 0 || t.outputs.length === 0) {
        throw bad("a template has at least one input and one output");
    }
    if (Math.max(t.inputs.length, t.outputs.length) > 0xffff) {
        throw bad("a template has at most 65535 inputs or outputs");
    }
    allOrNone("input", t.inputs);
    allOrNone("output", t.outputs);
    t.inputs.forEach(checkInput);
    t.outputs.forEach(checkOutput);
    t.issues?.forEach(checkIssue);
    for (const b of t.burns ?? []) {
        checkRoute(b);
        if (b.issue !== undefined) throw bad("a burn takes from an input");
    }
    checkIntOrVar(t.locktime, "locktime", 0, MAX_UINT32);
    if (t.fees) checkIntOrVar(t.fees.max, "fees max", 0, MAX);
    if (t.packets) checkPackets(t.packets);
    if (t.delegation) checkDelegation(t.delegation, t.inputs);
}

function allOrNone(what: string, slots: { index?: number }[]): void {
    let n = 0;
    for (const { index } of slots) {
        if (index === undefined) continue;
        if (index < 0) throw bad(`${what} index must not be negative`);
        n++;
    }
    if (n !== 0 && n !== slots.length) throw bad(`every ${what} states an index or none does`);
}

// Runs before normalization drops immediate schedules, so their keys are checked too.
function checkDelegation(d: Delegation, inputs: Input[]): void {
    const names = new Set(inputs.map((i) => i.name));
    for (const n of [...sortedKeys(d.schedule), ...sortedKeys(d.trigger)]) {
        if (!names.has(n)) throw bad(`delegation names no input ${q(n)}`);
    }
    for (const n of sortedKeys(d.schedule)) checkSchedule(d.schedule?.get(n) as Schedule);
    const sealed = new Set<string>();
    for (const x of d.sealed ?? []) {
        if (!NAME.test(x.name)) throw bad(`bad sealed name ${q(x.name)}`);
        if (sealed.has(x.name)) throw bad(`${q(x.name)} is sealed twice`);
        sealed.add(x.name);
    }
    const triggers = d.trigger ?? new Map<string, Trigger>();
    for (const n of sortedKeys(triggers)) {
        const tr = triggers.get(n) as Trigger;
        checkTrigger(tr);
        if ((tr.group !== undefined) !== triggers.size > 1) {
            throw bad(`trigger ${q(n)}: group goes with several rules and only with several rules`);
        }
    }
}

function checkInput(i: Input): void {
    if (!NAME.test(i.name)) throw bad(`bad input name ${q(i.name)}`);
    if (i.type !== undefined && !SLOT_TYPES.includes(i.type))
        throw bad(`unknown slot type ${q(i.type)}`);
    checkIntOrVar(i.sequence, "sequence", 0, MAX_UINT32);
    checkConstruction(i.contract);
}

function checkSchedule(s: Schedule): void {
    const set = [s.immediate, s.beforeExpiry, s.minConfirmations].filter((x) => x !== undefined);
    if (set.length !== 1) throw bad("a schedule has exactly one field");
    if (s.immediate === false) throw bad("immediate must be true");
    checkIntOrVar(s.beforeExpiry, "before_expiry_seconds", 1, MAX_UINT32);
    if (s.minConfirmations !== undefined) integer(s.minConfirmations, "min_confirmations", 1, MAX);
}

function checkConstruction(c: Construction): void {
    if (c.taptree !== undefined && !NAMED_VAR.test(c.taptree)) {
        throw bad(`taptree must name a bytes variable, got ${q(c.taptree)}`);
    }
}

function checkOutput(o: Output): void {
    if (!NAME.test(o.name)) throw bad(`bad output name ${q(o.name)}`);
    if (o.type !== undefined && !SLOT_TYPES.includes(o.type))
        throw bad(`unknown slot type ${q(o.type)}`);
    if (o.value.draws.length === 0) throw bad(`output ${q(o.name)} draws from no input`);
    if ("contract" in o.locking) checkConstruction(o.locking.contract);
    o.assets?.forEach(checkRoute);
}

function checkRoute(r: AssetRoute): void {
    if ((r.from === undefined) === (r.issue === undefined)) {
        throw bad("an asset route takes from an input or an issue");
    }
    if (r.issue !== undefined && (r.amount === undefined || r.asset !== undefined)) {
        throw bad("an issue route has an amount and no asset");
    }
    if (r.from !== undefined && r.amount !== undefined && r.asset === undefined) {
        throw bad("an asset amount needs an asset");
    }
}

function checkIssue(is: Issue): void {
    if (!NAME.test(is.name)) throw bad(`bad issue name ${q(is.name)}`);
    if (is.asset !== undefined && (is.control !== undefined || (is.metadata?.size ?? 0) > 0)) {
        throw bad(`issue ${q(is.name)}: control and metadata go with a new asset only`);
    }
}

function checkPackets(p: Packets): void {
    if (p.outputIndex !== undefined) integer(p.outputIndex, "output_index", 0, MAX);
    if (p.unmatched !== undefined && !UNMATCHEDS.includes(p.unmatched)) {
        throw bad("unmatched must be reject or drop");
    }
    for (const r of p.rules ?? []) {
        integer(r.type, "rule type", 2, 255);
        if (r.type === 5) throw bad("packet type 5 is reserved");
        if (!ACTIONS.includes(r.action)) throw bad(`unknown rule action ${q(r.action)}`);
        if ((r.data !== undefined) !== (r.action === "emit")) {
            throw bad("data goes with emit and only with emit");
        }
    }
    for (const a of p.advertise ?? []) {
        if (a.template !== "self" && !ID_HEX.test(a.template)) {
            throw bad(`bad advertisement target ${q(a.template)}`);
        }
        if (a.outputs.length === 0) throw bad("an advertisement needs outputs");
    }
}

function checkTrigger(tr: Trigger): void {
    integer(tr.packet, "trigger packet", 0, 255);
    if (tr.decode !== undefined && !DECODES.includes(tr.decode)) {
        throw bad("trigger decode must be tlv, records or raw");
    }
    integer(tr.expiresAfter, "expires_after_seconds", 1, MAX_UINT32);
    integer(tr.minValue, "trigger min_value", 0, MAX);
    if (tr.require.size === 0) throw bad("a trigger rule requires at least one field");
    if (tr.capture.size === 0) throw bad("a trigger rule captures at least one variable");
}

/** Drops what equals its default, in place, so spellings of one document share an id. */
export function normalize(t: Template): void {
    const def = t.type === "onchain" ? "onchain" : "offchain";
    for (const slot of [...t.inputs, ...t.outputs]) if (slot.type === def) slot.type = undefined;
    if (t.packets?.unmatched === "reject") t.packets.unmatched = undefined;
    const d = t.delegation;
    if (!d) return;
    d.trigger?.forEach((tr) => {
        if (tr.decode === "tlv") tr.decode = undefined;
    });
    for (const [n, s] of d.schedule ?? []) if (s.immediate !== undefined) d.schedule?.delete(n);
    if (!d.schedule?.size && !d.sealed?.length && !d.trigger?.size) t.delegation = undefined;
}

/** The value Go's struct tags and custom marshalers produce; its JCS bytes are the canonical form. */
export function marshal(t: Template): JsonObject {
    return obj({
        format: t.format,
        type: t.type,
        variables: dict(t.variables, String),
        inputs: t.inputs.map(input),
        outputs: t.outputs.map(output),
        fees: maybe(t.fees, (f) => obj({ from: f.from, max: intOrVar(f.max) })),
        issues: arr(t.issues, issue),
        burns: arr(t.burns, route),
        locktime: maybe(t.locktime, intOrVar),
        packets: maybe(t.packets, packets),
        delegation: maybe(t.delegation, delegation),
    });
}

const num = (n: number) => new JsonNumber(String(n));
const maybe = <T>(x: T | undefined, f: (x: T) => JsonValue) => (x === undefined ? undefined : f(x));
const arr = <T>(xs: T[] | undefined, f: (x: T) => JsonValue) =>
    xs?.length ? xs.map(f) : undefined;
const mapOf = <T>(m: Map<string, T>, f: (x: T) => JsonValue): JsonObject =>
    new Map([...m].map(([k, x]) => [k, f(x)]));
const dict = <T>(m: Map<string, T> | undefined, f: (x: T) => JsonValue) =>
    m?.size ? mapOf(m, f) : undefined;

function obj(fields: Record<string, JsonValue | undefined>): JsonObject {
    return new Map(
        Object.entries(fields).filter((e): e is [string, JsonValue] => e[1] !== undefined),
    );
}

function binding(b: Binding): JsonValue {
    if ("int" in b) return num(b.int);
    if ("bool" in b) return b.bool;
    if ("str" in b) return b.str;
    return obj({ program: b.program });
}

const intOrVar = (iv: IntOrVar): JsonValue => ("int" in iv ? num(iv.int) : `<${iv.var}>`);

function locking(l: Locking): JsonValue {
    if ("script" in l) return l.script;
    if ("contract" in l) return obj({ contract: construction(l.contract) });
    return obj({ from: l.from });
}

const construction = (c: Construction) =>
    obj({
        definition:
            "artifact" in c.definition
                ? obj({ artifact: c.definition.artifact })
                : canonicalDefinition(c.definition.def),
        arguments: dict(c.arguments, binding),
        taptree: c.taptree,
    });

const input = (i: Input) =>
    obj({
        name: i.name,
        type: i.type,
        index: maybe(i.index, num),
        sequence: maybe(i.sequence, intOrVar),
        contract: construction(i.contract),
        spend: obj({
            function: i.spend.function,
            leaf: i.spend.leaf,
            arguments: arr(i.spend.arguments, binding),
            witness: dict(i.spend.witness, binding),
        }),
    });

const draw = (d: Draw) => obj({ from: d.from, amount: maybe(d.amount, binding) });

const output = (o: Output) =>
    obj({
        name: o.name,
        type: o.type,
        index: maybe(o.index, num),
        each: o.each,
        value: o.value.list ? o.value.draws.map(draw) : draw(o.value.draws[0]),
        locking: locking(o.locking),
        assets: arr(o.assets, route),
    });

const route = (r: AssetRoute) =>
    obj({ from: r.from, issue: r.issue, asset: r.asset, amount: maybe(r.amount, binding) });

const issue = (i: Issue) =>
    obj({
        name: i.name,
        asset: i.asset,
        control: maybe(i.control, (c) => ("issue" in c ? obj({ issue: c.issue }) : c.asset)),
        metadata: dict(i.metadata, String),
    });

const packets = (p: Packets) =>
    obj({
        output_index: maybe(p.outputIndex, num),
        unmatched: p.unmatched,
        rules: arr(p.rules, (r) =>
            obj({
                type: num(r.type),
                action: r.action,
                from: r.from,
                data: maybe(r.data, binding),
            }),
        ),
        advertise: arr(p.advertise, (a) => obj({ template: a.template, outputs: [...a.outputs] })),
    });

const delegation = (d: Delegation) =>
    obj({
        schedule: dict(d.schedule, (s) =>
            obj({
                immediate: s.immediate,
                before_expiry_seconds: maybe(s.beforeExpiry, intOrVar),
                min_confirmations: maybe(s.minConfirmations, num),
            }),
        ),
        sealed: arr(d.sealed, (s) =>
            s.scheme === undefined ? s.name : obj({ name: s.name, scheme: s.scheme }),
        ),
        trigger: dict(d.trigger, (tr) =>
            obj({
                packet: num(tr.packet),
                decode: tr.decode,
                min_value: tr.minValue === 0 ? undefined : num(tr.minValue),
                all_outputs: tr.allOutputs || undefined,
                require: mapOf(tr.require, String),
                capture: mapOf(tr.capture, String),
                group: tr.group,
                expires_after_seconds: num(tr.expiresAfter),
            }),
        ),
    });
