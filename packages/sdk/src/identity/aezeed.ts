import { blake2b } from "@noble/hashes/blake2.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** Highest aezeed internal version this SDK opens. Newer phrases are refused, never guessed at. */
export const AEZEED_VERSION = 0;

const GENESIS_SECONDS = 1231006505;
const DAY_SECONDS = 86400;
const SCRYPT_OPTS = { N: 32768, r: 8, p: 1, dkLen: 32 };
const TAU = 4;
const NO_NONCE = new Uint8Array(0);
const WORD_INDEX = new Map(wordlist.map((word, i) => [word, i]));

/** The plaintext of an lnd aezeed phrase. */
export interface AezeedSeed {
    version: number;
    /** Day-resolution creation date carried in the words. */
    birthday: Date;
    /** 16 bytes, used as the BIP32 master seed (as lnd does). */
    entropy: Uint8Array;
}

/** Opens a 24-word aezeed phrase. Throws on a bad word, checksum or passphrase, or an unknown version. */
export async function decodeAezeed(phrase: string, passphrase?: string): Promise<AezeedSeed> {
    const raw = phraseToBytes(phrase);
    const salt = raw.subarray(24, 29);
    const key = await stretch(passphrase, salt);
    const plain = aezDecrypt(key, NO_NONCE, [aezeedAd(salt)], TAU, raw.subarray(1, 24));
    if (!plain) throw new Error("Invalid aezeed passphrase");
    const version = plain[0];
    assertAezeedVersion(version);
    const days = (plain[1] << 8) | plain[2];
    return {
        version,
        birthday: new Date((GENESIS_SECONDS + days * DAY_SECONDS) * 1000),
        entropy: plain.slice(3),
    };
}

/** Enciphers `seed` into 24 words. `salt` is random unless given (test vectors pin it). */
export async function encodeAezeed(
    seed: AezeedSeed,
    opts: { passphrase?: string; salt?: Uint8Array } = {},
): Promise<string> {
    const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(5));
    if (seed.entropy.length !== 16 || salt.length !== 5) {
        throw new Error("aezeed needs 16 bytes of entropy and a 5-byte salt");
    }
    if (!Number.isInteger(seed.version) || seed.version < 0 || seed.version > 0xff) {
        throw new Error(`Invalid aezeed version ${seed.version}`);
    }
    const days = Math.floor((seed.birthday.getTime() / 1000 - GENESIS_SECONDS) / DAY_SECONDS);
    if (!(days >= 0 && days <= 0xffff)) throw new Error("aezeed birthday out of range");

    const plain = new Uint8Array([seed.version, days >> 8, days & 0xff, ...seed.entropy]);
    const key = await stretch(opts.passphrase, salt);
    const raw = new Uint8Array(33);
    raw.set(aezEncrypt(key, NO_NONCE, [aezeedAd(salt)], TAU, plain), 1);
    raw.set(salt, 24);
    new DataView(raw.buffer).setUint32(29, crc32c(raw.subarray(0, 29)));
    return bytesToPhrase(raw);
}

/** @internal Throws for an internal version outside what this SDK opens. */
export function assertAezeedVersion(version: number): void {
    if (!(version >= 0 && version <= AEZEED_VERSION)) {
        throw new Error(`Unsupported aezeed version ${version}`);
    }
}

/** True when `phrase` is a well-formed aezeed (words, version byte, checksum). Needs no passphrase. */
export function isAezeedMnemonic(phrase: string): boolean {
    try {
        phraseToBytes(phrase);
        return true;
    } catch {
        return false;
    }
}

const aezeedAd = (salt: Uint8Array) => new Uint8Array([0, ...salt]);

const stretch = (passphrase: string | undefined, salt: Uint8Array) =>
    scryptAsync(new TextEncoder().encode(passphrase || "aezeed"), salt, SCRYPT_OPTS);

function phraseToBytes(phrase: string): Uint8Array {
    const words = phrase.trim().toLowerCase().split(/\s+/);
    if (words.length !== 24) throw new Error("Invalid aezeed: expected 24 words");
    const out = new Uint8Array(33);
    let acc = 0;
    let bits = 0;
    let o = 0;
    for (const word of words) {
        const index = WORD_INDEX.get(word);
        if (index === undefined) throw new Error(`Invalid aezeed: unknown word "${word}"`);
        acc = (acc << 11) | index;
        bits += 11;
        while (bits >= 8) {
            bits -= 8;
            out[o++] = (acc >>> bits) & 0xff;
        }
        acc &= (1 << bits) - 1;
    }
    if (new DataView(out.buffer).getUint32(29) !== crc32c(out.subarray(0, 29))) {
        throw new Error("Invalid aezeed checksum");
    }
    if (out[0] !== 0) throw new Error(`Unsupported aezeed cipher version ${out[0]}`);
    return out;
}

function bytesToPhrase(bytes: Uint8Array): string {
    const words: string[] = [];
    let acc = 0;
    let bits = 0;
    for (const byte of bytes) {
        acc = (acc << 8) | byte;
        bits += 8;
        if (bits >= 11) {
            bits -= 11;
            words.push(wordlist[(acc >>> bits) & 0x7ff]);
            acc &= (1 << bits) - 1;
        }
    }
    return words.join(" ");
}

const CRC32C_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? (n >>> 1) ^ 0x82f63b78 : n >>> 1;
    return n;
});

function crc32c(data: Uint8Array): number {
    let c = ~0;
    for (const byte of data) c = CRC32C_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
}

// ── AEZ v5, ported from github.com/guggero/aez, itself a port of github.com/Yawning/aez (CC0) ──
// guggero/aez is under the MIT License:
//
// Copyright (c) 2011-2018 bitcoinjs-lib contributors
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

const BLOCK = 16;
const ZERO = new Uint8Array(BLOCK);
const xtime = (b: number) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;

const SBOX = (() => {
    const box = new Uint8Array(256);
    const rotl = (x: number, s: number) => ((x << s) | (x >> (8 - s))) & 0xff;
    let p = 1;
    let q = 1;
    do {
        p ^= xtime(p);
        q ^= q << 1;
        q ^= q << 2;
        q ^= q << 4;
        q &= 0xff;
        if (q & 0x80) q ^= 0x09;
        box[p] = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4) ^ 0x63;
    } while (p !== 1);
    box[0] = 0x63;
    return box;
})();

/** One AES round with MixColumns (AEZ keeps it in every round, the last included). */
function aesRound(s: Uint8Array, roundKey: Uint8Array): void {
    const t = new Uint8Array(BLOCK);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) t[4 * c + r] = SBOX[s[4 * ((c + r) % 4) + r]];
    }
    for (let c = 0; c < BLOCK; c += 4) {
        const [a0, a1, a2, a3] = [t[c], t[c + 1], t[c + 2], t[c + 3]];
        const all = a0 ^ a1 ^ a2 ^ a3;
        s[c] = a0 ^ all ^ xtime(a0 ^ a1) ^ roundKey[c];
        s[c + 1] = a1 ^ all ^ xtime(a1 ^ a2) ^ roundKey[c + 1];
        s[c + 2] = a2 ^ all ^ xtime(a2 ^ a3) ^ roundKey[c + 2];
        s[c + 3] = a3 ^ all ^ xtime(a3 ^ a0) ^ roundKey[c + 3];
    }
}

function xorInto(dst: Uint8Array, src: Uint8Array): void {
    for (let i = 0; i < BLOCK; i++) dst[i] ^= src[i];
}

function double(p: Uint8Array): void {
    const carry = p[0] >> 7;
    for (let i = 0; i < BLOCK - 1; i++) p[i] = (p[i] << 1) | (p[i + 1] >> 7);
    p[BLOCK - 1] = (p[BLOCK - 1] << 1) ^ (carry ? 0x87 : 0);
}

function mult(x: number, src: Uint8Array): Uint8Array {
    const t = src.slice();
    const r = new Uint8Array(BLOCK);
    for (; x !== 0; x >>= 1) {
        if (x & 1) xorInto(r, t);
        double(t);
    }
    return r;
}

interface AezKey {
    I: Uint8Array[];
    J: Uint8Array;
    L: Uint8Array[];
    roundKeys: Uint8Array[];
}

function aezKey(key: Uint8Array): AezKey {
    const extracted = key.length === 48 ? key : blake2b(key, { dkLen: 48 });
    const [I, J, L] = [0, 16, 32].map((o) => extracted.slice(o, o + BLOCK));
    return {
        I: [I, mult(2, I)],
        J,
        L: Array.from({ length: 8 }, (_, i) => mult(i, L)),
        roundKeys: [J, I, L, ZERO],
    };
}

function aes4(k: AezKey, j: Uint8Array, i: Uint8Array, l: Uint8Array, x: Uint8Array): Uint8Array {
    const s = new Uint8Array(BLOCK);
    for (let n = 0; n < BLOCK; n++) s[n] = j[n] ^ i[n] ^ l[n] ^ x[n];
    for (const roundKey of k.roundKeys) aesRound(s, roundKey);
    return s;
}

function aezHash(k: AezKey, nonce: Uint8Array, ad: Uint8Array[], tauBits: number): Uint8Array {
    const tauBlock = new Uint8Array(BLOCK);
    new DataView(tauBlock.buffer).setUint32(12, tauBits);
    const sum = aes4(k, mult(3, k.J), k.I[1], k.L[1], tauBlock);
    [nonce, ...ad].forEach((part, idx) => {
        const j = mult(4 + idx, k.J);
        const I = k.I[1].slice();
        let off = 0;
        for (let i = 1; part.length - off >= BLOCK; i++, off += BLOCK) {
            xorInto(sum, aes4(k, j, I, k.L[i % 8], part.subarray(off, off + BLOCK)));
            if (i % 8 === 0) double(I);
        }
        if (off < part.length || part.length === 0) {
            const padded = new Uint8Array(BLOCK);
            padded.set(part.subarray(off));
            padded[part.length - off] = 0x80;
            xorInto(sum, aes4(k, j, k.I[0], k.L[0], padded));
        }
    });
    return sum;
}

function aezTiny(k: AezKey, delta: Uint8Array, input: Uint8Array, decrypt: boolean): Uint8Array {
    const n = input.length;
    const half = n >> 1;
    const halfUp = (n + 1) >> 1;
    const [rounds, li] = n === 1 ? [24, 7] : n === 2 ? [16, 7] : n < BLOCK ? [10, 7] : [8, 6];
    const L = new Uint8Array(BLOCK);
    const R = new Uint8Array(BLOCK);
    L.set(input.subarray(0, halfUp));
    R.set(input.subarray(half, half + halfUp));
    let mask = 0x00;
    let pad = 0x80;
    if (n & 1) {
        // An odd length splits mid-byte; shift R up a nibble so both halves start aligned.
        for (let i = 0; i < half; i++) R[i] = (R[i] << 4) | (R[i + 1] >> 4);
        R[half] <<= 4;
        mask = 0xf0;
        pad = 0x08;
    }
    const topBit = (x: Uint8Array) => {
        const buf = new Uint8Array(BLOCK);
        buf.set(x.subarray(0, n));
        buf[0] |= 0x80;
        xorInto(buf, delta);
        return aes4(k, ZERO, k.I[1], k.L[3], buf)[0] & 0x80;
    };
    const feistel = (side: Uint8Array, tweak: number) => {
        const buf = new Uint8Array(BLOCK);
        buf.set(side.subarray(0, halfUp));
        buf[half] = (buf[half] & mask) | pad;
        xorInto(buf, delta);
        buf[15] ^= tweak;
        return aes4(k, ZERO, k.I[1], k.L[li], buf);
    };

    if (decrypt && n < BLOCK) L[0] ^= topBit(input);
    const step = decrypt ? -1 : 1;
    for (let r = 0, j = decrypt ? rounds - 1 : 0; r < rounds / 2; r++, j += 2 * step) {
        xorInto(L, feistel(R, j));
        xorInto(R, feistel(L, j + step));
    }

    const out = new Uint8Array(2 * BLOCK);
    out.set(R.subarray(0, half));
    out.set(L.subarray(0, halfUp), half);
    if (n & 1) {
        for (let i = n - 1; i > half; i--) out[i] = (out[i] >> 4) | (out[i - 1] << 4);
        out[half] = (L[0] >> 4) | (R[half] & 0xf0);
    }
    const result = out.slice(0, n);
    if (!decrypt && n < BLOCK) result[0] ^= topBit(result);
    return result;
}

// ponytail: AEZ-tiny only (ciphertexts of 1..31 bytes; aezeed's is 23). Port aezCore from the
// same reference if a caller ever needs longer messages.
/** @internal Exported for the AEZ known-answer tests. */
export function aezEncrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    ad: Uint8Array[],
    tau: number,
    plaintext: Uint8Array,
): Uint8Array {
    const n = plaintext.length + tau;
    if (plaintext.length === 0 || n >= 2 * BLOCK) throw new Error("aez: unsupported length");
    const k = aezKey(key);
    const x = new Uint8Array(n);
    x.set(plaintext);
    return aezTiny(k, aezHash(k, nonce, ad, tau * 8), x, false);
}

/** @internal Returns null when the tag doesn't verify (wrong key, or tampered input). */
export function aezDecrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    ad: Uint8Array[],
    tau: number,
    ciphertext: Uint8Array,
): Uint8Array | null {
    const n = ciphertext.length;
    if (n <= tau || n >= 2 * BLOCK) throw new Error("aez: unsupported length");
    const k = aezKey(key);
    const x = aezTiny(k, aezHash(k, nonce, ad, tau * 8), ciphertext, true);
    return x.subarray(n - tau).every((b) => b === 0) ? x.slice(0, n - tau) : null;
}
