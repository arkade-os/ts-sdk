import { equalBytes } from "@noble/curves/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { scriptError } from "./errors";

// Go's gob framing of a sha256 context (opcode.go:2780-2795), copied from the oracle's
// sha256_framing.json: it depends on process-global gob type ids, so it is never derived here.
export const SHA256_STATE_PREFIX = hex.decode("097f060102ff8200000070ff80006c");
export const SHA256_STATE_LEN = 123;

const MAGIC = hex.decode("73686103");
const U64 = (1n << 64n) - 1n;

interface NobleSha256 {
    buffer: Uint8Array;
    pos: number;
    get(): number[];
    set(...words: number[]): void;
    update(data: Uint8Array): unknown;
}

// noble's `length` is a float; Go's is a uint64 a witness can set to anything, so it lives here
interface Sha256State {
    readonly h: NobleSha256;
    len: bigint;
}

const fresh = (): Sha256State => ({ h: sha256.create() as unknown as NobleSha256, len: 0n });

function write(s: Sha256State, data: Uint8Array): Sha256State {
    s.h.update(data);
    s.len = (s.len + BigInt(data.length)) & U64;
    return s;
}

function encode(s: Sha256State): Uint8Array {
    const out = new Uint8Array(SHA256_STATE_LEN);
    const view = new DataView(out.buffer);
    const at = SHA256_STATE_PREFIX.length;
    out.set(SHA256_STATE_PREFIX);
    out.set(MAGIC, at);
    s.h.get().forEach((w, i) => view.setUint32(at + 4 + 4 * i, w));
    // noble leaves processed bytes past pos in its buffer
    out.set(s.h.buffer.subarray(0, s.h.pos), at + 36);
    view.setBigUint64(at + 100, s.len);
    return out;
}

// Only the framing and the magic are checked: like UnmarshalBinary, any h words and any length
// are accepted, and the pending byte count is len % 64 whatever the buffer holds past it.
function decode(state: Uint8Array): Sha256State {
    const at = SHA256_STATE_PREFIX.length;
    const framed =
        state.length === SHA256_STATE_LEN && SHA256_STATE_PREFIX.every((b, i) => state[i] === b);
    if (!framed) throw scriptError("ErrInvalidStackOperation", "invalid hash state");
    if (!MAGIC.every((b, i) => state[at + i] === b)) {
        throw scriptError("ErrInvalidStackOperation", "failed to load hash state");
    }
    const view = new DataView(state.buffer, state.byteOffset, state.length);
    const s = fresh();
    s.h.set(...Array.from({ length: 8 }, (_, i) => view.getUint32(at + 4 + 4 * i)));
    s.h.buffer.set(state.subarray(at + 36, at + 100));
    s.len = view.getBigUint64(at + 100);
    s.h.pos = Number(s.len % 64n);
    return s;
}

// Go's checkSum padding, pushed through update so noble's float length is never read.
function sum(s: Sha256State): Uint8Array {
    const pending = Number(s.len % 64n);
    const t = pending < 56 ? 56 - pending : 120 - pending;
    const pad = new Uint8Array(t + 8);
    pad[0] = 0x80;
    new DataView(pad.buffer).setBigUint64(t, (s.len << 3n) & U64);
    s.h.update(pad);
    const out = new Uint8Array(32);
    const view = new DataView(out.buffer);
    s.h.get().forEach((w, i) => view.setUint32(4 * i, w));
    return out;
}

const initialize = (data: Uint8Array): Uint8Array => encode(write(fresh(), data));
const update = (state: Uint8Array, data: Uint8Array): Uint8Array =>
    encode(write(decode(state), data));
const finalize = (state: Uint8Array, data: Uint8Array): Uint8Array =>
    sum(write(decode(state), data));

// Checked on first use, not at import, so the SDK still loads if an upgrade breaks it.
let verified = false;
function verify(): void {
    if (verified) return;
    // The probe compresses a block before the first set(), so a no-op set() cannot pass on the IV.
    const probe = new TextEncoder().encode("abc".repeat(30));
    try {
        const state = update(initialize(probe.subarray(0, 70)), probe.subarray(70, 80));
        if (!equalBytes(finalize(state, probe.subarray(80)), sha256(probe))) {
            throw new Error("midstate round trip gave a wrong digest");
        }
    } catch (cause) {
        throw new Error(
            "vm/hash.ts: the @noble/hashes sha256 internals it drives (buffer, pos, get, set) changed",
            { cause },
        );
    }
    verified = true;
}

export const sha256Initialize = (data: Uint8Array): Uint8Array => (verify(), initialize(data));

export const sha256Update = (state: Uint8Array, data: Uint8Array): Uint8Array => (
    verify(), update(state, data)
);

export const sha256Finalize = (state: Uint8Array, data: Uint8Array): Uint8Array => (
    verify(), finalize(state, data)
);
