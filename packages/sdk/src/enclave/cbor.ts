/**
 * Minimal CBOR (RFC 8949) for AWS Nitro attestation documents: decodes the COSE_Sign1 envelope
 * and its payload, and encodes the COSE `Sig_structure`. What the Nitro format never uses —
 * floats, indefinite-length strings, tags other than COSE_Sign1's — is rejected rather than
 * half-supported. Indefinite-length arrays and maps are decoded: the NSM writes its payload map
 * that way.
 */

export type CborMap = Map<number | string, CborValue>;
export type CborValue =
    | number
    | bigint
    | string
    | Uint8Array
    | boolean
    | null
    | undefined
    | CborValue[]
    | CborMap;

const MAX_DEPTH = 16;
const COSE_SIGN1_TAG = 18;
const BREAK = Symbol("break");

export function decodeCbor(bytes: Uint8Array): CborValue {
    const reader = new Reader(bytes);
    const value = reader.item(0);
    if (value === BREAK) throw new Error("CBOR: unexpected break");
    if (reader.offset !== bytes.length) throw new Error("CBOR: trailing bytes");
    return value;
}

class Reader {
    offset = 0;

    constructor(private readonly bytes: Uint8Array) {}

    item(depth: number): CborValue | typeof BREAK {
        if (depth > MAX_DEPTH) throw new Error("CBOR: nesting too deep");
        const initial = this.take(1)[0];
        const major = initial >> 5;
        const info = initial & 0x1f;
        switch (major) {
            case 0: {
                const value = this.argument(info);
                return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
            }
            case 1: {
                const value = -1n - this.argument(info);
                return value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value;
            }
            case 2:
                return this.take(this.length(info)).slice();
            case 3:
                return new TextDecoder("utf-8", { fatal: true }).decode(
                    this.take(this.length(info)),
                );
            case 4: {
                if (info === 31) return this.indefiniteArray(depth);
                const items: CborValue[] = [];
                for (let n = this.length(info); n > 0; n--) items.push(this.value(depth + 1));
                return items;
            }
            case 5:
                return this.map(depth, info === 31 ? undefined : this.length(info));
            case 6: {
                // only COSE_Sign1's tag, and only around the whole document. The tag is optional
                // (the NSM omits it): tagged or not, the document decodes to the same array.
                const tag = this.argument(info);
                if (depth !== 0 || tag !== BigInt(COSE_SIGN1_TAG)) {
                    throw new Error(`CBOR: unsupported tag ${tag}`);
                }
                return this.value(depth + 1);
            }
            default:
                // major 7: false, true, null, undefined, or the break ending an indefinite item
                return this.simple(info);
        }
    }

    private value(depth: number): CborValue {
        const value = this.item(depth);
        if (value === BREAK) throw new Error("CBOR: unexpected break");
        return value;
    }

    private indefiniteArray(depth: number): CborValue[] {
        const items: CborValue[] = [];
        for (;;) {
            const value = this.item(depth + 1);
            if (value === BREAK) return items;
            items.push(value);
        }
    }

    private map(depth: number, size: number | undefined): CborMap {
        const map: CborMap = new Map();
        for (let n = 0; size === undefined || n < size; n++) {
            const key = this.item(depth + 1);
            if (key === BREAK) {
                if (size === undefined) return map;
                throw new Error("CBOR: unexpected break");
            }
            if (typeof key !== "number" && typeof key !== "string") {
                throw new Error("CBOR: map keys must be integers or text");
            }
            if (map.has(key)) throw new Error(`CBOR: duplicate map key ${String(key)}`);
            map.set(key, this.value(depth + 1));
        }
        return map;
    }

    private simple(info: number): CborValue | typeof BREAK {
        switch (info) {
            case 20:
                return false;
            case 21:
                return true;
            case 22:
                return null;
            case 23:
                return undefined;
            case 31:
                return BREAK;
            default:
                throw new Error(`CBOR: unsupported simple value or float (${info})`);
        }
    }

    private argument(info: number): bigint {
        if (info < 24) return BigInt(info);
        // Only arrays and maps may be indefinite-length, and they check for it before reading.
        if (info === 31) throw new Error("CBOR: indefinite length for a definite-only item");
        const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
        if (size === 0) throw new Error(`CBOR: reserved additional info ${info}`);
        let value = 0n;
        for (const byte of this.take(size)) value = (value << 8n) | BigInt(byte);
        return value;
    }

    private length(info: number): number {
        const arg = this.argument(info);
        if (arg > BigInt(this.bytes.length - this.offset)) throw new Error("CBOR: truncated");
        return Number(arg);
    }

    private take(n: number): Uint8Array {
        if (this.offset + n > this.bytes.length) throw new Error("CBOR: truncated");
        const out = this.bytes.subarray(this.offset, this.offset + n);
        this.offset += n;
        return out;
    }
}

/** Definite-length encoding, enough for the COSE `Sig_structure`. */
export function encodeCbor(value: CborValue): Uint8Array {
    const chunks: Uint8Array[] = [];
    write(value, chunks);
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

const utf8Encoder = new TextEncoder();

function write(value: CborValue, out: Uint8Array[]): void {
    if (value instanceof Uint8Array) {
        out.push(head(2, BigInt(value.length)), value);
    } else if (typeof value === "string") {
        const bytes = utf8Encoder.encode(value);
        out.push(head(3, BigInt(bytes.length)), bytes);
    } else if (typeof value === "number" || typeof value === "bigint") {
        if (typeof value === "number" && !Number.isSafeInteger(value)) {
            throw new Error("CBOR: only integers are supported");
        }
        const n = BigInt(value);
        out.push(n >= 0n ? head(0, n) : head(1, -1n - n));
    } else if (Array.isArray(value)) {
        out.push(head(4, BigInt(value.length)));
        for (const item of value) write(item, out);
    } else if (value instanceof Map) {
        out.push(head(5, BigInt(value.size)));
        for (const [key, item] of value) {
            write(key, out);
            write(item, out);
        }
    } else {
        out.push(
            Uint8Array.of(
                value === false ? 0xf4 : value === true ? 0xf5 : value === null ? 0xf6 : 0xf7,
            ),
        );
    }
}

function head(major: number, n: bigint): Uint8Array {
    const m = major << 5;
    if (n < 24n) return Uint8Array.of(m | Number(n));
    const size = n < 0x100n ? 1 : n < 0x10000n ? 2 : n < 0x100000000n ? 4 : 8;
    const out = new Uint8Array(1 + size);
    out[0] = m | (size === 1 ? 24 : size === 2 ? 25 : size === 4 ? 26 : 27);
    for (let i = size; i > 0; i--, n >>= 8n) out[i] = Number(n & 0xffn);
    return out;
}
