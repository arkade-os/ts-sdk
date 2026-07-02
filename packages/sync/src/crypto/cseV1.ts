import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64 } from "@scure/base";

/**
 * `cse-v1` client-side encryption envelope — TypeScript port of the reference
 * implementation in the bucket-sync-server repo (`src/BucketSync.Cse/CseV1Envelope.cs`),
 * following the wire format documented in `docs/cse-v1.md`.
 *
 * The data is sealed under a random per-record DEK (AES-256-GCM); the DEK is
 * wrapped (also AES-256-GCM) to the owner under a 32-byte key-wrapping key (KWK).
 * The whole envelope is JSON (UTF-8) — opaque to the server, which only reads
 * the `scheme` tag. The KWK is derived from the seed and is deliberately
 * distinct from the BIP-340 signing key (see {@link deriveKwk}).
 */

/** The scheme tag carried in the envelope and in the server entry's `scheme` field. */
export const CSE_V1_SCHEME = "cse-v1";

const DATA_ALG = "AES-256-GCM";
const TAG_LEN = 16;
const IV_LEN = 12;
const DEK_LEN = 32;
const KWK_LEN = 32;

/** HKDF `info` label that domain-separates the key-wrapping key from the signing key. */
const KWK_INFO = "bucket-sync:cse-v1:kwk";

/** Pluggable CSPRNG so tests can inject a deterministic source. */
export type RandomBytes = (n: number) => Uint8Array;

const webcryptoRandom: RandomBytes = (n) => {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
};

interface Recipient {
    type: string;
    wrappedDek: string; // base64
    nonce: string; // base64
    tag: string; // base64
}

interface Envelope {
    v: string;
    alg: string;
    recipients: Recipient[];
    iv: string; // base64
    ct: string; // base64
    tag: string; // base64
}

export interface SealOptions {
    /** Override the CSPRNG (tests inject a deterministic source). Defaults to WebCrypto. */
    randomBytes?: RandomBytes;
}

/**
 * Derive the 32-byte key-wrapping key (KWK) from a wallet seed via HKDF-SHA256
 * with a fixed, domain-separated `info` label. Deliberately distinct from the
 * BIP-340 signing key (spec §7): reusing one key for both signing and
 * encryption is the antipattern this envelope avoids. Deterministic — any
 * device restoring from the same seed derives the same KWK and can open every
 * envelope.
 */
export function deriveKwk(seed: Uint8Array): Uint8Array {
    return hkdf(sha256, seed, undefined, new TextEncoder().encode(KWK_INFO), KWK_LEN);
}

/** AES-256-GCM encrypt; splits out the trailing 16-byte tag (cse-v1 stores ct and tag separately). */
function gcmEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array) {
    const out = gcm(key, iv).encrypt(plaintext); // noble appends the tag: ct || tag
    return {
        ct: out.subarray(0, out.length - TAG_LEN),
        tag: out.subarray(out.length - TAG_LEN),
    };
}

/** AES-256-GCM decrypt; recombines noble's expected `ct || tag` layout. Throws on a bad tag. */
function gcmDecrypt(key: Uint8Array, iv: Uint8Array, ct: Uint8Array, tag: Uint8Array): Uint8Array {
    const combined = new Uint8Array(ct.length + tag.length);
    combined.set(ct, 0);
    combined.set(tag, ct.length);
    return gcm(key, iv).decrypt(combined);
}

/**
 * Seal plaintext into a `cse-v1` envelope (UTF-8 JSON bytes) under a 32-byte KWK.
 * The returned bytes are what a client base64-encodes into a commit op's `value`.
 */
export function seal(plaintext: Uint8Array, kwk: Uint8Array, opts: SealOptions = {}): Uint8Array {
    if (kwk.length !== KWK_LEN) throw new Error(`key-wrapping key must be ${KWK_LEN} bytes`);
    const rand = opts.randomBytes ?? webcryptoRandom;

    const dek = rand(DEK_LEN);
    try {
        const iv = rand(IV_LEN);
        const data = gcmEncrypt(dek, iv, plaintext);

        const wrapNonce = rand(IV_LEN);
        const wrap = gcmEncrypt(kwk, wrapNonce, dek);

        const envelope: Envelope = {
            v: CSE_V1_SCHEME,
            alg: DATA_ALG,
            recipients: [
                {
                    type: "owner",
                    wrappedDek: base64.encode(wrap.ct),
                    nonce: base64.encode(wrapNonce),
                    tag: base64.encode(wrap.tag),
                },
            ],
            iv: base64.encode(iv),
            ct: base64.encode(data.ct),
            tag: base64.encode(data.tag),
        };
        return new TextEncoder().encode(JSON.stringify(envelope));
    } finally {
        dek.fill(0);
    }
}

/**
 * Open a `cse-v1` envelope with the KWK, returning the plaintext. Throws if the
 * scheme is unexpected, the owner recipient is missing, or GCM authentication
 * fails (wrong key or tampering).
 */
export function open(envelopeBytes: Uint8Array, kwk: Uint8Array): Uint8Array {
    let envelope: Envelope;
    try {
        envelope = JSON.parse(new TextDecoder().decode(envelopeBytes)) as Envelope;
    } catch {
        throw new Error("malformed cse-v1 envelope");
    }
    if (envelope?.v !== CSE_V1_SCHEME) throw new Error(`unexpected scheme: ${envelope?.v}`);

    const recipient = envelope.recipients?.find((r) => r.type === "owner");
    if (!recipient) throw new Error("no owner recipient");

    const dek = gcmDecrypt(
        kwk,
        base64.decode(recipient.nonce),
        base64.decode(recipient.wrappedDek),
        base64.decode(recipient.tag),
    );
    try {
        return gcmDecrypt(
            dek,
            base64.decode(envelope.iv),
            base64.decode(envelope.ct),
            base64.decode(envelope.tag),
        );
    } finally {
        dek.fill(0);
    }
}
