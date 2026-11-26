import { hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";

import {
    DECIMAL_TOKEN,
    HEX_TOKEN,
    opcode,
    PLACEHOLDER,
    parseDecimal,
    SCALAR_TYPES,
    serviceKey,
} from "./asm";
import { fail } from "./errors";
import { canonical, decode, type JsonObject, type JsonValue } from "./jcs";

export { SCALAR_TYPES };

export interface Field {
    name: string;
    type: string;
}

export interface Struct {
    name: string;
    fields: Field[];
}

export interface WitnessItem {
    name: string;
    type: string;
    encoding: string;
    injected: boolean;
}

export interface Leaf {
    name: string;
    asm: string[];
    witness: WitnessItem[];
}

export interface Covenant {
    inputs: Field[];
    asm: string[];
}

export interface ArtifactFunction {
    name: string;
    arkade?: Covenant;
    leaves: Leaf[];
}

/** An artifact/v1 contract definition, without compiler metadata. */
export interface Definition {
    contractName: string;
    constructorInputs: Field[];
    structs: Struct[];
    functions: ArtifactFunction[];
}

const ENCODINGS = ["schnorr-64", "raw", "raw-20", "raw-32", "scriptnum"];
const METADATA = ["formatVersion", "source", "compiler", "updatedAt", "fingerprint"];
const BUILTINS = new Map<string, Field[]>([
    [
        "AssetId",
        [
            { name: "txid", type: "bytes32" },
            { name: "gidx", type: "int" },
        ],
    ],
    [
        "Outpoint",
        [
            { name: "txid", type: "bytes32" },
            { name: "vout", type: "int" },
        ],
    ],
    [
        "ECPoint",
        [
            { name: "x", type: "int" },
            { name: "y", type: "int" },
        ],
    ],
]);
const MAX_ARRAY = 1024;
const MAX_CONSTRUCTOR = 1024;
const MAX_CONSTRUCTOR_BYTES = 1 << 20;
const ARRAY_TYPE = /^([a-z0-9]+)\[([1-9][0-9]*)\]$/;
const utf8 = new TextEncoder();

const invalid = (message: string) => fail("invalid_artifact", message);

/** Decodes a compiler artifact, dropping its metadata; the id commits to the canonical form. */
export function decodeArtifact(raw: Uint8Array): { id: string; definition: Definition } {
    let doc: JsonValue;
    try {
        doc = decode(raw);
    } catch (e) {
        throw invalid((e as Error).message);
    }
    if (!(doc instanceof Map)) throw invalid("not an object");
    for (const k of METADATA) doc.delete(k);
    const definition = parseDefinition(doc);
    return { id: hex.encode(sha256(canonical(canonicalDefinition(definition)))), definition };
}

export function parseDefinition(v: JsonValue): Definition {
    const m = object(
        v,
        "definition",
        ["contractName", "constructorInputs", "functions"],
        ["structs"],
    );
    const def: Definition = {
        contractName: name(m.get("contractName"), "contractName"),
        constructorInputs: parseFields(m.get("constructorInputs"), "constructor input"),
        structs: m.has("structs") ? parseStructs(m.get("structs")) : [],
        functions: [],
    };
    const names = new Map<string, string>();
    for (const f of flatten(def, def.constructorInputs)) {
        if (names.has(f.name)) throw invalid(`duplicate constructor field "${f.name}"`);
        names.set(f.name, f.type);
    }
    const list = m.get("functions");
    if (!Array.isArray(list) || list.length === 0) {
        throw invalid("functions must be a non-empty array");
    }
    const fns = new Set<string>();
    for (const e of list) {
        const f = parseFunction(e);
        if (fns.has(f.name)) throw invalid(`duplicate function "${f.name}"`);
        fns.add(f.name);
        def.functions.push(f);
    }
    const covenants = new Set(def.functions.filter((f) => f.arkade).map((f) => f.name));
    for (const f of def.functions) {
        if (f.arkade) checkAsm(covenants, f.arkade.asm, names);
        for (const l of f.leaves) checkAsm(covenants, l.asm, names);
    }
    return def;
}

/** A deep copy, as Go's Artifact.Definition returns. */
export function copyDefinition(d: Definition): Definition {
    const fields = (fs: readonly Field[]) => fs.map((f) => ({ ...f }));
    return {
        contractName: d.contractName,
        constructorInputs: fields(d.constructorInputs),
        structs: d.structs.map((s) => ({ name: s.name, fields: fields(s.fields) })),
        functions: d.functions.map((f) => ({
            name: f.name,
            ...(f.arkade && {
                arkade: { inputs: fields(f.arkade.inputs), asm: [...f.arkade.asm] },
            }),
            leaves: f.leaves.map((l) => ({
                name: l.name,
                asm: [...l.asm],
                witness: l.witness.map((w) => ({ ...w })),
            })),
        })),
    };
}

/** The form the id commits to: structs always present, arkade and injected only when set. */
export function canonicalDefinition(def: Definition): JsonObject {
    const fields = (fs: Field[]): JsonValue[] =>
        fs.map(
            (f) =>
                new Map([
                    ["name", f.name],
                    ["type", f.type],
                ]),
        );
    const functions = def.functions.map((f) => {
        const fn: JsonObject = new Map([["name", f.name]]);
        if (f.arkade) {
            fn.set(
                "arkade",
                new Map<string, JsonValue>([
                    ["inputs", fields(f.arkade.inputs)],
                    ["asm", [...f.arkade.asm]],
                ]),
            );
        }
        const leaves = f.leaves.map((l) => {
            const witness = l.witness.map((w) => {
                const item: JsonObject = new Map([
                    ["name", w.name],
                    ["type", w.type],
                    ["encoding", w.encoding],
                ]);
                if (w.injected) item.set("injected", true);
                return item;
            });
            return new Map<string, JsonValue>([
                ["name", l.name],
                ["asm", [...l.asm]],
                ["witness", witness],
            ]);
        });
        fn.set("leaves", leaves);
        return fn;
    });
    return new Map<string, JsonValue>([
        ["contractName", def.contractName],
        ["constructorInputs", fields(def.constructorInputs)],
        [
            "structs",
            def.structs.map(
                (s) =>
                    new Map<string, JsonValue>([
                        ["name", s.name],
                        ["fields", fields(s.fields)],
                    ]),
            ),
        ],
        ["functions", functions],
    ]);
}

/** The scalars of `fields`, in place: arrays as `name.0`, structs as `name.field`, recursively. */
export function flatten(def: Definition, fields: readonly Field[]): Field[] {
    const out: Field[] = [];
    let steps = 0;
    let size = 0;
    const tooMany = () => invalid(`constructor flattens to more than ${MAX_CONSTRUCTOR} fields`);
    const walk = (name: string, type: string): void => {
        if (++steps > MAX_CONSTRUCTOR || out.length >= MAX_CONSTRUCTOR) throw tooMany();
        const array = ARRAY_TYPE.exec(type);
        const n = array ? Number(array[2]) : 1;
        if (array && (n > MAX_ARRAY || !SCALAR_TYPES.includes(array[1]))) {
            throw invalid(`unsupported type "${type}"`);
        }
        const bytes = utf8.encode(name).length;
        if (bytes > Math.floor((MAX_CONSTRUCTOR_BYTES - size) / n)) {
            throw invalid(`constructor names flatten to more than ${MAX_CONSTRUCTOR_BYTES} bytes`);
        }
        size += n * bytes;
        if (SCALAR_TYPES.includes(type)) {
            out.push({ name, type });
            return;
        }
        if (array) {
            if (out.length + n > MAX_CONSTRUCTOR) throw tooMany();
            for (let i = 0; i < n; i++) out.push({ name: `${name}.${i}`, type: array[1] });
            return;
        }
        const struct = BUILTINS.get(type) ?? def.structs.find((s) => s.name === type)?.fields;
        if (!struct) throw invalid(`unsupported type "${type}"`);
        for (const f of struct) walk(`${name}.${f.name}`, f.type);
    };
    for (const f of fields) walk(f.name, f.type);
    return out;
}

// Covenant inputs reach the VM on the stack, so they are never placeholders.
function checkAsm(
    covenants: ReadonlySet<string>,
    tokens: string[],
    names: Map<string, string>,
): void {
    const covenant = (fn: string) => covenants.has(fn);
    const check = (parse: () => number) => {
        try {
            parse();
        } catch (e) {
            throw invalid((e as Error).message);
        }
    };
    for (const tok of tokens) {
        if (tok.startsWith("OP_")) {
            check(() => opcode(tok));
            continue;
        }
        if (DECIMAL_TOKEN.test(tok)) {
            check(() => parseDecimal(tok));
            continue;
        }
        if (HEX_TOKEN.test(tok)) continue;
        const p = PLACEHOLDER.exec(tok)?.[1];
        if (p === undefined) throw invalid(`unsupported token "${tok}"`);
        const parts = p.split(":");
        if (serviceKey(p) === "OPERATOR_KEY" || serviceKey(p) === "BATCH_COSIGNER_KEY") continue;
        if (parts[0] === "EMULATOR_KEY" && parts.length === 2) {
            if (!covenant(parts[1])) throw invalid(`"${tok}" names no function with arkade`);
        } else if (parts[0] === "TWEAK" && parts.length === 3) {
            if (names.get(parts[1]) !== "pubkey" || !covenant(parts[2])) {
                throw invalid(`bad tweak "${tok}"`);
            }
        } else if (parts.length === 1) {
            if (!names.has(p)) throw invalid(`unknown placeholder "${tok}"`);
        } else {
            throw invalid(`unsupported placeholder "${tok}"`);
        }
    }
}

// A field can only use a struct declared before it.
function parseStructs(v: JsonValue | undefined): Struct[] {
    if (!Array.isArray(v)) throw invalid("structs is not an array");
    const declared = new Set(BUILTINS.keys());
    return v.map((e) => {
        const m = object(e, "struct", ["name", "fields"]);
        const structName = name(m.get("name"), "struct name");
        if (declared.has(structName)) throw invalid(`duplicate struct "${structName}"`);
        const fields = parseFields(m.get("fields"), "struct field");
        for (const f of fields) {
            if (!validType(f.type, declared)) throw invalid(`unsupported type "${f.type}"`);
        }
        declared.add(structName);
        return { name: structName, fields };
    });
}

function parseFunction(v: JsonValue): ArtifactFunction {
    const m = object(v, "function", ["name", "leaves"], ["arkade"]);
    const f: ArtifactFunction = { name: name(m.get("name"), "function name"), leaves: [] };
    const raw = m.get("arkade");
    if (raw !== undefined) {
        const a = object(raw, "arkade", ["inputs", "asm"]);
        const inputs = parseFields(a.get("inputs"), "arkade input");
        for (const i of inputs) {
            if (!validType(i.type)) throw invalid(`unsupported arkade input type "${i.type}"`);
        }
        f.arkade = { inputs, asm: strs(a.get("asm"), "asm") };
    }
    const list = m.get("leaves");
    if (!Array.isArray(list) || list.length === 0)
        throw invalid(`function "${f.name}" needs leaves`);
    const leaves = new Set<string>();
    for (const e of list) {
        const l = parseLeaf(e);
        if (leaves.has(l.name)) throw invalid(`duplicate leaf "${l.name}"`);
        leaves.add(l.name);
        f.leaves.push(l);
    }
    return f;
}

function parseLeaf(v: JsonValue): Leaf {
    const m = object(v, "leaf", ["name", "asm", "witness"]);
    const l: Leaf = {
        name: name(m.get("name"), "leaf name"),
        asm: strs(m.get("asm"), "asm"),
        witness: [],
    };
    const ws = m.get("witness");
    if (!Array.isArray(ws)) throw invalid("witness is not an array");
    const items = new Set<string>();
    for (const w of ws) {
        const wm = object(w, "witness item", ["name", "type", "encoding"], ["injected"]);
        const itemName = name(wm.get("name"), "witness name");
        const type = wm.get("type");
        const encoding = wm.get("encoding");
        const injected = wm.has("injected") ? wm.get("injected") : false;
        if (typeof type !== "string" || !SCALAR_TYPES.includes(type)) {
            throw invalid(`unsupported witness type ${JSON.stringify(type)}`);
        }
        if (typeof encoding !== "string" || !ENCODINGS.includes(encoding)) {
            throw invalid(`unsupported witness encoding ${JSON.stringify(encoding)}`);
        }
        if (typeof injected !== "boolean") throw invalid("injected is not a boolean");
        if (items.has(itemName)) throw invalid(`duplicate witness item "${itemName}"`);
        items.add(itemName);
        l.witness.push({ name: itemName, type, encoding, injected });
    }
    return l;
}

function validType(t: string, structs?: Set<string>): boolean {
    const array = ARRAY_TYPE.exec(t);
    if (array) return Number(array[2]) <= MAX_ARRAY && SCALAR_TYPES.includes(array[1]);
    return SCALAR_TYPES.includes(t) || (structs?.has(t) ?? false);
}

function object(
    v: JsonValue | undefined,
    what: string,
    required: string[],
    optional: string[] = [],
): JsonObject {
    if (!(v instanceof Map)) throw invalid(`${what} is not an object`);
    for (const k of required) if (!v.has(k)) throw invalid(`${what} misses "${k}"`);
    for (const k of v.keys()) {
        if (!required.includes(k) && !optional.includes(k)) {
            throw invalid(`${what} has unknown field "${k}"`);
        }
    }
    return v;
}

function name(v: JsonValue | undefined, what: string): string {
    if (typeof v !== "string" || v === "") throw invalid(`${what} must be a non-empty string`);
    return v;
}

function strs(v: JsonValue | undefined, what: string): string[] {
    if (!Array.isArray(v)) throw invalid(`${what} is not an array`);
    return v.map((e) => {
        if (typeof e !== "string") throw invalid(`${what} holds a non-string`);
        return e;
    });
}

function parseFields(v: JsonValue | undefined, what: string): Field[] {
    if (!Array.isArray(v)) throw invalid(`${what}s is not an array`);
    const out: Field[] = [];
    const seen = new Set<string>();
    for (const e of v) {
        const m = object(e, what, ["name", "type"]);
        const f = {
            name: name(m.get("name"), `${what} name`),
            type: name(m.get("type"), `${what} type`),
        };
        if (seen.has(f.name)) throw invalid(`duplicate ${what} "${f.name}"`);
        seen.add(f.name);
        out.push(f);
    }
    return out;
}
