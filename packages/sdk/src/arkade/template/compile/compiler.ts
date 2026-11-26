import { hex } from "@scure/base";

import type { Definition } from "../abi";
import {
    canonicalBytes,
    checkExpression as checkTokens,
    parseScriptNum,
    SPLICE,
    scriptNum,
} from "../asm";
import { Failure, fail } from "../errors";
import type * as schema from "../schema";
import { NAME } from "../schema";
import {
    type ByteTemplate,
    type LockSpec,
    literal,
    names,
    type Template,
    tokenName,
} from "./model";

/** Decoded artifacts by the id a document names them under. */
export type Artifacts = ReadonlyMap<
    string,
    { readonly id: string; readonly definition: Definition }
>;

export interface Compiler {
    artifacts: Artifacts;
    definitions: Map<string, Definition>;
    doc: schema.Template;
    t: Template;
    /** Variables some binding uses. */
    named: Set<string>;
    /** The slots of the inputs and outputs compiled so far, by name. */
    inputSlots: Map<string, number>;
    outputSlots: Map<string, number>;
}

const HASH_OPS = ["OP_HASH160", "OP_SHA256", "OP_HASH256", "OP_RIPEMD160"];
const utf8 = new TextEncoder();
const text = new TextDecoder();

export const q = JSON.stringify;
export const bad = (message: string) => fail("invalid_template", message);

/** Go's `fmt.Errorf("%s: %w")`: a prefix, the kinds kept. */
export function within<T>(prefix: string, f: () => T): T {
    try {
        return f();
    } catch (e) {
        if (!(e instanceof Failure)) throw e;
        throw new Failure(e.kinds, `${prefix}: ${e.message}`, e.path);
    }
}

export function inputIndex(c: Compiler, name: string, what: string): number {
    const i = c.inputSlots.get(name);
    if (i === undefined) throw bad(`${what} names no input: ${q(name)}`);
    return i;
}

export function intVariable(c: Compiler, v: schema.IntOrVar): LockSpec {
    if ("int" in v) return { n: v.int };
    if (c.t.variables.get(v.var) !== "int") throw bad(`${q(`<${v.var}>`)} is not an int variable`);
    return { n: 0, variable: v.var };
}

export function slotType(c: Compiler, given: string | undefined): boolean {
    const def = c.t.type === "onchain" ? "onchain" : "virtual";
    const typ = given ?? def;
    if (c.t.type !== "proof" && typ !== def) {
        throw bad(`${typ} slot in a template of type ${c.t.type}`);
    }
    return typ === "onchain";
}

// Walks UTF-8 bytes as Go does, so the offsets in messages agree.
export function parseByteTemplate(s: string): ByteTemplate {
    const b = utf8.encode(s);
    const str = (from: number, to: number) => text.decode(b.subarray(from, to));
    const out: ByteTemplate = [];
    for (let i = 0; i < b.length; ) {
        const c = b[i];
        if (c === 0x3c) {
            const end = b.indexOf(0x3e, i);
            if (end < 0 || !NAME.test(str(i + 1, end))) throw bad(`bad placeholder at ${i}`);
            out.push({ name: str(i + 1, end) });
            i = end + 1;
        } else if (c === 0x24 && b[i + 1] === 0x28) {
            const end = b.indexOf(0x29, i);
            if (end < 0) throw bad(`unclosed expression at ${i}`);
            const body = str(i + 2, end);
            if (
                body === "" ||
                /[$(]/.test(body) ||
                body.startsWith(" ") ||
                body.endsWith(" ") ||
                body.includes("  ")
            ) {
                throw bad(`bad expression at ${i}`);
            }
            const toks = body.split(" ");
            for (const t of toks) {
                if (t.startsWith("<") && (!t.endsWith(">") || !NAME.test(tokenName(t)))) {
                    throw bad(`bad placeholder ${q(t)}`);
                }
            }
            out.push({ expr: toks });
            i = end + 1;
        } else if (isHex(c)) {
            let j = i;
            while (j < b.length && isHex(b[j])) j++;
            if ((j - i) % 2 !== 0) throw bad(`odd number of hex digits at ${i}`);
            out.push({ hex: hex.decode(str(i, j)) });
            i = j;
        } else {
            throw bad(`unexpected ${quoteByte(c)} at ${i}`);
        }
    }
    return out;
}

const isHex = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66);

const RUNE_ESCAPES = new Map([
    [0x07, "a"],
    [0x08, "b"],
    [0x09, "t"],
    [0x0a, "n"],
    [0x0b, "v"],
    [0x0c, "f"],
    [0x0d, "r"],
    [0x27, "'"],
    [0x5c, "\\"],
]);

// Go's %q of a byte: strconv.QuoteRune of its value.
function quoteByte(c: number): string {
    const e = RUNE_ESCAPES.get(c);
    if (e !== undefined) return `'\\${e}'`;
    const h = c.toString(16).padStart(2, "0");
    if (c < 0x20 || c === 0x7f) return `'\\x${h}'`;
    if ((c >= 0x80 && c <= 0xa0) || c === 0xad) return `'\\u00${h}'`;
    return `'${String.fromCharCode(c)}'`;
}

/** Literals and lone names are typed here, the rest when evaluated; typ "" is any bytes. */
export function bind(c: Compiler, v: schema.Binding, typ: string): ByteTemplate {
    let b: ByteTemplate;
    if ("program" in v)
        throw bad(`output program ${q(v.program)} can only fill a contract argument`);
    if ("int" in v) {
        if (typ !== "int") throw bad(`an integer cannot fill a ${typ} field`);
        b = [{ hex: scriptNum(v.int) }];
    } else if ("bool" in v) {
        if (typ !== "bool") throw bad(`a boolean cannot fill a ${typ} field`);
        b = [{ hex: v.bool ? Uint8Array.of(1) : new Uint8Array() }];
    } else {
        b = parseByteTemplate(v.str);
    }
    for (const n of names(b)) {
        if (!c.t.variables.has(n)) throw bad(`undeclared name ${q(n)}`);
        c.named.add(n);
    }
    for (const p of b) if ("expr" in p) checkExpression(c, p.expr);
    if (typ === "") return b;
    const lit = literal(b);
    if (lit !== undefined) {
        try {
            canonicalBytes(typ, lit);
        } catch (e) {
            throw bad((e as Error).message);
        }
    }
    if (b.length === 1 && "name" in b[0] && typ !== "bytes") {
        const declared = c.t.variables.get(b[0].name);
        if (declared !== typ) throw bad(`${declared} ${q(b[0].name)} cannot fill a ${typ} field`);
    }
    return b;
}

export function checkExpression(c: Compiler, expr: readonly string[]): void {
    for (const tok of expr) {
        const m = SPLICE.exec(tok);
        if (m && c.t.variables.get(m[1]) !== "bytes") {
            throw bad(`spliced variable ${q(m[1])} is not bytes`);
        }
    }
    try {
        checkTokens(expr);
    } catch (e) {
        throw bad(`expression: ${(e as Error).message}`);
    }
}

export function scriptBind(c: Compiler, v: schema.Binding, typ: string): ByteTemplate {
    const b = bind(c, v, typ);
    for (const p of b) {
        for (const n of names([p])) {
            if (
                c.t.sealed.has(n) &&
                !("expr" in p && HASH_OPS.includes(p.expr[p.expr.length - 1]))
            ) {
                throw bad(`sealed ${q(n)} must be hashed in a contract argument`);
            }
        }
    }
    return b;
}

export function amount(c: Compiler, v: schema.Binding): ByteTemplate {
    const b = bind(c, v, "int");
    const lit = literal(b);
    if (lit !== undefined && numberOrZero(lit) < 1) throw bad("an amount must be positive");
    return b;
}

// Go ignores ParseScriptNum's error at these call sites, reading 0.
export function numberOrZero(raw: Uint8Array): number {
    try {
        return parseScriptNum(raw);
    } catch {
        return 0;
    }
}
