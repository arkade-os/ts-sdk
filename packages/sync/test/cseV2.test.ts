import { describe, it, expect } from "vitest";
import { base64 } from "@scure/base";
import { seal, open, deriveKwk, cseAad, CSE_V2_SCHEME } from "../src/crypto/cseV2";

const kwk = () => crypto.getRandomValues(new Uint8Array(32));
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("cse-v2 envelope", () => {
    it("round-trips seal then open with the same key", () => {
        const k = kwk();
        const pt = enc(JSON.stringify({ vtxo: "abc", amount: 1000 }));
        const env = seal(pt, k, "swap:abc");
        expect(dec(env)).not.toEqual(dec(pt));
        expect(open(env, k, "swap:abc")).toEqual(pt);
    });

    it("throws when opened with the wrong key", () => {
        const env = seal(enc("secret"), kwk(), "swap:abc");
        expect(() => open(env, kwk(), "swap:abc")).toThrow();
    });

    it("throws on tampered ciphertext (GCM auth, not JSON parsing)", () => {
        const k = kwk();
        const env = seal(enc("secret payload"), k, "swap:abc");
        // Corrupt a byte inside `ct` — still valid JSON, still valid base64 —
        // so the GCM tag (not the parser) must reject it.
        const obj = JSON.parse(dec(env));
        const ct = base64.decode(obj.ct);
        ct[0] ^= 0xff;
        obj.ct = base64.encode(ct);
        expect(() => open(enc(JSON.stringify(obj)), k, "swap:abc")).toThrow();
    });

    it("throws on tampered wrapped-DEK", () => {
        const k = kwk();
        const obj = JSON.parse(dec(seal(enc("secret"), k, "swap:abc")));
        const w = base64.decode(obj.recipients[0].wrappedDek);
        w[0] ^= 0xff;
        obj.recipients[0].wrappedDek = base64.encode(w);
        expect(() => open(enc(JSON.stringify(obj)), k, "swap:abc")).toThrow();
    });

    it("advertises the cse-v2 scheme", () => {
        expect(dec(seal(enc("x"), kwk(), "swap:abc"))).toContain(CSE_V2_SCHEME);
    });

    it("produces an envelope matching the documented cse-v2 wire format", () => {
        const obj = JSON.parse(dec(seal(enc("hello world"), kwk(), "swap:abc")));
        expect(obj.v).toBe("cse-v2");
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
        const obj = JSON.parse(dec(seal(pt, kwk(), "swap:abc")));
        expect(base64.decode(obj.ct).length).toBe(pt.length);
    });

    it("rejects a non-32-byte KWK on seal", () => {
        expect(() => seal(enc("x"), new Uint8Array(16), "swap:abc")).toThrow();
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
        expect(open(seal(new Uint8Array(0), k, "swap:abc"), k, "swap:abc")).toEqual(
            new Uint8Array(0),
        );
    });

    it("rejects a key-wrapping key that is not 32 bytes, on open as well as seal", () => {
        const env = seal(enc("x"), kwk(), "swap:abc");
        // AES-GCM accepts 16- and 24-byte keys, so without an explicit guard open()
        // would decrypt envelopes wrapped under AES-128/192 — weaker than this scheme
        // permits, and something seal() refuses to produce.
        for (const len of [16, 24]) {
            const short = new Uint8Array(len);
            expect(() => seal(enc("x"), short, "swap:abc")).toThrow();
            expect(() => open(env, short, "swap:abc")).toThrow();
        }
    });

    it("binds the envelope to its bucket key", () => {
        const k = kwk();
        const env = seal(enc("owned by swap:abc"), k, "swap:abc");

        // The whole point of v2: a server that relocates a record's ciphertext to a
        // different key cannot make the client accept it.
        expect(() => open(env, k, "swap:victim")).toThrow();
        expect(dec(open(env, k, "swap:abc"))).toBe("owned by swap:abc");
    });

    it("derives AAD that is domain-separated and key-bound", () => {
        expect(dec(cseAad("swap:abc"))).toBe("bucket-sync:cse-v2:swap:abc");
        expect(cseAad("a")).not.toEqual(cseAad("b"));
    });

    /**
     * The interop vector published in docs/cse-v2.md of the bucket-sync-server repo,
     * also opened by the C# reference implementation's test of the same name. If the two
     * ever disagree the implementations have silently diverged — both can be internally
     * consistent and still mutually unreadable, and only a shared vector catches that.
     */
    it("opens the published interop vector", () => {
        const kwkHex = "4b2f8a1c6d3e5f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8";
        const kwk = Uint8Array.from(kwkHex.match(/../g)!.map((h) => parseInt(h, 16)));
        const envelope = base64.decode(
            "eyJ2IjoiY3NlLXYyIiwiYWxnIjoiQUVTLTI1Ni1HQ00iLCJyZWNpcGllbnRzIjpbeyJ0eXBlIjoib3duZXIiLCJ3cmFwcGVk" +
                "RGVrIjoiZEZyQVB4a05XTm9PVlZKdGRvYnR2ZDQxK0FLc3NVQmVPaDF0UTF6SWp1dz0iLCJub25jZSI6IkdmSjZURnovWnJp" +
                "UkpSRVciLCJ0YWciOiIvSW82STVCWis5eXp1WkpncUdPV3N3PT0ifV0sIml2IjoiMGNqa0s3VTVyVXBKY0VzeSIsImN0Ijoi" +
                "QUJMNTUvM1RGbWs4Z254bk5EeXZMZUE1a2UzZERZUkEzVW5HM1FiOVRBZ2tydzhKWTQ5SVBnR3JWdz09IiwidGFnIjoiNlZN" +
                "Wm1GaFFNTUdpQ3orNnNhZUN3QT09In0=",
        );

        expect(dec(open(envelope, kwk, "swap:interop"))).toBe(
            '{"id":"swap-interop","preimage":"deadbeef"}',
        );
        // Same bytes, wrong key name — the binding must reject it.
        expect(() => open(envelope, kwk, "contract:other")).toThrow();
    });
});
