import { describe, it, expect } from "vitest";
import { base64 } from "@scure/base";
import { seal, open, deriveKwk, CSE_V1_SCHEME } from "../src/crypto/cseV1";

const kwk = () => crypto.getRandomValues(new Uint8Array(32));
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("cse-v1 envelope", () => {
    it("round-trips seal then open with the same key", () => {
        const k = kwk();
        const pt = enc(JSON.stringify({ vtxo: "abc", amount: 1000 }));
        const env = seal(pt, k);
        expect(dec(env)).not.toEqual(dec(pt));
        expect(open(env, k)).toEqual(pt);
    });

    it("throws when opened with the wrong key", () => {
        const env = seal(enc("secret"), kwk());
        expect(() => open(env, kwk())).toThrow();
    });

    it("throws on tampered ciphertext (GCM auth, not JSON parsing)", () => {
        const k = kwk();
        const env = seal(enc("secret payload"), k);
        // Corrupt a byte inside `ct` — still valid JSON, still valid base64 —
        // so the GCM tag (not the parser) must reject it.
        const obj = JSON.parse(dec(env));
        const ct = base64.decode(obj.ct);
        ct[0] ^= 0xff;
        obj.ct = base64.encode(ct);
        expect(() => open(enc(JSON.stringify(obj)), k)).toThrow();
    });

    it("throws on tampered wrapped-DEK", () => {
        const k = kwk();
        const obj = JSON.parse(dec(seal(enc("secret"), k)));
        const w = base64.decode(obj.recipients[0].wrappedDek);
        w[0] ^= 0xff;
        obj.recipients[0].wrappedDek = base64.encode(w);
        expect(() => open(enc(JSON.stringify(obj)), k)).toThrow();
    });

    it("advertises the cse-v1 scheme", () => {
        expect(dec(seal(enc("x"), kwk()))).toContain(CSE_V1_SCHEME);
    });

    it("produces an envelope matching the documented cse-v1 wire format", () => {
        const obj = JSON.parse(dec(seal(enc("hello world"), kwk())));
        expect(obj.v).toBe("cse-v1");
        expect(obj.alg).toBe("AES-256-GCM");
        expect(base64.decode(obj.iv).length).toBe(12);
        expect(base64.decode(obj.tag).length).toBe(16);
        expect(obj.recipients).toHaveLength(1);
        expect(obj.recipients[0].type).toBe("owner");
        expect(base64.decode(obj.recipients[0].wrappedDek).length).toBe(32);
        expect(base64.decode(obj.recipients[0].nonce).length).toBe(12);
        expect(base64.decode(obj.recipients[0].tag).length).toBe(16);
    });

    it("ciphertext length equals plaintext length (GCM is a stream cipher)", () => {
        const pt = enc("a variable length message of some size");
        const obj = JSON.parse(dec(seal(pt, kwk())));
        expect(base64.decode(obj.ct).length).toBe(pt.length);
    });

    it("rejects a non-32-byte KWK on seal", () => {
        expect(() => seal(enc("x"), new Uint8Array(16))).toThrow();
    });

    it("derives a deterministic 32-byte KWK from a seed", () => {
        const seed = crypto.getRandomValues(new Uint8Array(64));
        const a = deriveKwk(seed);
        const b = deriveKwk(seed);
        expect(a).toEqual(b);
        expect(a.length).toBe(32);
    });

    it("derives different KWKs from different seeds", () => {
        const a = deriveKwk(crypto.getRandomValues(new Uint8Array(64)));
        const b = deriveKwk(crypto.getRandomValues(new Uint8Array(64)));
        expect(a).not.toEqual(b);
    });

    it("round-trips an empty plaintext", () => {
        const k = kwk();
        expect(open(seal(new Uint8Array(0), k), k)).toEqual(new Uint8Array(0));
    });
});
