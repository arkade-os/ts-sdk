const MAX_DEPTH = 64;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
};
const QUOTED: Record<string, string> = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
};
// ignoreBOM keeps a leading BOM in the text so the tokenizer refuses it, as encoding/json does.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** A JSON number kept as its literal text; {@link checkNumbers} judges it. */
export class JsonNumber {
    constructor(readonly text: string) {}
}

export type JsonObject = Map<string, JsonValue>;
export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | JsonObject;

export class JcsError extends Error {}

/** Parses one JSON value, refusing invalid UTF-8, duplicate keys, lone surrogates and trailing data. */
export function decode(doc: Uint8Array): JsonValue {
    let s: string;
    try {
        s = utf8.decode(doc);
    } catch {
        throw new JcsError("invalid utf-8");
    }
    let i = 0;
    const fail = (what: string): never => {
        throw new JcsError(`${what} at offset ${i}`);
    };
    const ws = () => {
        while (s[i] === " " || s[i] === "\t" || s[i] === "\n" || s[i] === "\r") i++;
    };
    const hex4 = (): number => {
        const h = s.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(h)) fail("invalid unicode escape");
        i += 4;
        return parseInt(h, 16);
    };
    const string = (): string => {
        let out = "";
        let start = ++i;
        for (;;) {
            const c = s.charCodeAt(i);
            if (Number.isNaN(c)) fail("unterminated string");
            if (c === 0x22) break;
            if (c < 0x20) fail("control character in string");
            if (c !== 0x5c) {
                i++;
                continue;
            }
            out += s.slice(start, i);
            const e = s[i + 1];
            i += 2;
            if (e !== "u") {
                if (ESCAPES[e] === undefined) fail("invalid escape");
                out += ESCAPES[e];
            } else {
                const u = hex4();
                if (u >= 0xdc00 && u <= 0xdfff) fail("lone low surrogate escape");
                if (u < 0xd800 || u > 0xdbff) out += String.fromCharCode(u);
                else {
                    if (s[i] !== "\\" || s[i + 1] !== "u") fail("lone high surrogate escape");
                    i += 2;
                    const l = hex4();
                    if (l < 0xdc00 || l > 0xdfff) fail("lone high surrogate escape");
                    out += String.fromCharCode(u, l);
                }
            }
            start = i;
        }
        out += s.slice(start, i++);
        return out;
    };
    const value = (depth: number): JsonValue => {
        ws();
        const c = s[i];
        if (c === "[" || c === "{") {
            if (depth >= MAX_DEPTH) fail(`nesting deeper than ${MAX_DEPTH}`);
            i++;
            ws();
            const close = c === "[" ? "]" : "}";
            const arr: JsonValue[] = [];
            const obj: JsonObject = new Map();
            if (s[i] === close) {
                i++;
                return c === "[" ? arr : obj;
            }
            for (;;) {
                if (c === "[") arr.push(value(depth + 1));
                else {
                    ws();
                    if (s[i] !== '"') fail("expected a string key");
                    const key = string();
                    if (obj.has(key)) fail(`duplicate key ${JSON.stringify(key)}`);
                    ws();
                    if (s[i++] !== ":") fail("expected a colon");
                    obj.set(key, value(depth + 1));
                }
                ws();
                const next = s[i++];
                if (next === close) return c === "[" ? arr : obj;
                if (next !== ",") fail(`expected a comma or ${close}`);
            }
        }
        if (c === '"') return string();
        NUMBER.lastIndex = i;
        const n = NUMBER.exec(s);
        if (n) {
            i += n[0].length;
            return new JsonNumber(n[0]);
        }
        for (const [word, v] of [
            ["true", true],
            ["false", false],
            ["null", null],
        ] as const) {
            if (s.startsWith(word, i)) {
                i += word.length;
                return v;
            }
        }
        return fail("unexpected character");
    };
    const v = value(0);
    ws();
    if (i < s.length) fail("trailing data");
    return v;
}

/** An integer of magnitude at most 2^53-1, written without fraction, exponent or "-0". */
export function safeInt(n: JsonNumber): number {
    const v = Number(n.text);
    if (!/^-?[0-9]+$/.test(n.text) || n.text === "-0" || !Number.isSafeInteger(v)) {
        throw new JcsError(`unsupported number ${n.text}`);
    }
    return v;
}

/** Refuses any number {@link canonical} would. */
export function checkNumbers(v: JsonValue): void {
    if (v instanceof JsonNumber) safeInt(v);
    else if (Array.isArray(v)) v.forEach(checkNumbers);
    else if (v instanceof Map) v.forEach(checkNumbers);
}

/** RFC 8785, restricted to safe integers. Keys sort by UTF-16 code units, which is JS's default. */
export function canonical(v: JsonValue): Uint8Array {
    return encoder.encode(write(v));
}

function write(v: JsonValue): string {
    if (v === null || typeof v === "boolean") return String(v);
    if (typeof v === "string") return quote(v);
    if (v instanceof JsonNumber) return String(safeInt(v));
    if (Array.isArray(v)) return `[${v.map(write).join(",")}]`;
    const keys = [...v.keys()].sort();
    return `{${keys.map((k) => `${quote(k)}:${write(v.get(k) as JsonValue)}`).join(",")}}`;
}

function quote(s: string): string {
    const escaped = s.replace(
        /["\\\u0000-\u001f]/g,
        (c) => QUOTED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    return `"${escaped}"`;
}

/** Go's string order (bytewise UTF-8, i.e. code points), which differs from JS sort for non-BMP. */
export function compareGo(a: string, b: string): number {
    const x = [...a];
    const y = [...b];
    for (let k = 0; k < Math.min(x.length, y.length); k++) {
        const d = (x[k].codePointAt(0) as number) - (y[k].codePointAt(0) as number);
        if (d !== 0) return d;
    }
    return x.length - y.length;
}
