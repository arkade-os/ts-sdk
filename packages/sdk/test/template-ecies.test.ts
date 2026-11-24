import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { open, seal } from "../src/arkade/template/ecies";

// executor pkg/template/ecies/testdata/vector.json @ af8d9eb, sealed from entropy 0x33*32 || 0x44*12.
const VECTOR = {
    privkey: "01".repeat(32),
    pubkey: "031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
    plaintext: "22".repeat(32),
    ciphertext:
        "023c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1" +
        "444444444444444444444444" +
        "37a99a0aa2d5588724bb1cc12363afeed4b93d6c341f2266f4a3a409d60434184c66b61d0e1fb61cdc1c0d1aaaaab646",
};
// template_id of the executor's example-vhtlc-non-interactive-claim vector, which seals `preimage`.
const TEMPLATE_ID = "02eaf02c22283cb67dfeb49fe8cdc7b726d6ff24e80682940eca451309048486";
const PREIMAGE = new Uint8Array(32).fill(0x07);
// Both open to PREIMAGE under TEMPLATE_ID in ecies.go @ af8d9eb: one sealed here, one by Go's Encrypt.
const SEALED_HERE =
    "023c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1" +
    "444444444444444444444444" +
    "128cbf2f87f07da2019e39e406468acbf19c1849113a0743d186812cf321113db1f036acbd0d079d383ca4460bb45cc2";
const SEALED_BY_GO =
    "03a3972239b1801fd9ed6b055ef4ffed563aca2b6bc87acc83e0cc9e422c53bc4d" +
    "1c636d5de5102ce5f114d38b" +
    "c683fd4a18d982025f0b51876e2c72ca43adb460ac60f2f999cc5666ac1d0bfbe97b5280f2e682bc3dcd779141498a51";

const priv = hex.decode(VECTOR.privkey);
const pub = secp256k1.getPublicKey(priv, true);

// Read in Go's Encrypt order from crypto/rand: the 32-byte ephemeral key, then the nonce.
const vectorEntropy = () => {
    const bytes = new Uint8Array(44).fill(0x33, 0, 32).fill(0x44, 32);
    let offset = 0;
    return (n: number) => bytes.slice(offset, (offset += n));
};

describe("template ecies", () => {
    it("opens the executor's known-answer vector", () => {
        expect(hex.encode(pub)).toBe(VECTOR.pubkey);
        expect(hex.encode(open(priv, hex.decode(VECTOR.ciphertext), ""))).toBe(VECTOR.plaintext);
    });

    it("seals the known-answer vector from its entropy", () => {
        const sealed = seal(pub, hex.decode(VECTOR.plaintext), "", vectorEntropy());
        expect(hex.encode(sealed)).toBe(VECTOR.ciphertext);
    });

    it("seals under a template id the bytes Go's Decrypt opens", () => {
        expect(hex.encode(seal(pub, PREIMAGE, TEMPLATE_ID, vectorEntropy()))).toBe(SEALED_HERE);
    });

    it("opens Go's seal under its template id only", () => {
        const sealed = hex.decode(SEALED_BY_GO);
        expect(open(priv, sealed, TEMPLATE_ID)).toEqual(PREIMAGE);
        expect(() => open(priv, sealed, "template-a")).toThrow(/^ecies: decrypt:/);
        expect(() => open(priv, sealed, "")).toThrow(/^ecies: decrypt:/);
    });

    it("round-trips under one template id and no other", () => {
        const key = secp256k1.utils.randomSecretKey();
        const plaintext = new TextEncoder().encode("a secret preimage, arbitrary length");
        const sealed = seal(secp256k1.getPublicKey(key, true), plaintext, "template-a");
        expect(open(key, sealed, "template-a")).toEqual(plaintext);
        expect(() => open(key, sealed, "template-b")).toThrow(/^ecies: decrypt:/);
    });

    it("refuses an rng that yields a short nonce", () => {
        const rng = (n: number) => new Uint8Array(n === 32 ? 32 : 11).fill(0x33);
        expect(() => seal(pub, PREIMAGE, TEMPLATE_ID, rng)).toThrow(/^ecies: generate nonce/);
    });

    it("refuses an ephemeral key that is not a valid scalar", () => {
        const rng = (n: number) => new Uint8Array(n);
        expect(() => seal(pub, PREIMAGE, TEMPLATE_ID, rng)).toThrow(
            /^ecies: generate ephemeral key/,
        );
    });

    describe("rejects what Go's Decrypt rejects, at the same stage", () => {
        const sealed = hex.decode(SEALED_HERE);
        const flipped = (i: number) => {
            const out = sealed.slice();
            out[i] ^= 0xff;
            return out;
        };
        const offCurve = new Uint8Array(61).fill(0xff, 1, 33);
        offCurve[0] = 0x02;
        const parse = /^ecies: invalid ephemeral public key/;
        const auth = /^ecies: decrypt:/;

        it.each([
            // Byte 0 is the SEC1 prefix, so Go fails parsing it ("unsupported format: fd"), not the AAD.
            { name: "flipped ephemeral pubkey byte (aad)", ciphertext: flipped(0), error: parse },
            { name: "flipped nonce byte", ciphertext: flipped(33), error: auth },
            {
                name: "flipped ciphertext byte",
                ciphertext: flipped(sealed.length - 1),
                error: auth,
            },
            {
                name: "short input",
                ciphertext: new Uint8Array(60),
                error: /^ecies: ciphertext too short: got 60 bytes, need at least 61$/,
            },
            {
                name: "invalid compressed-key prefix",
                ciphertext: new Uint8Array(61).fill(0x04, 0, 1),
                error: parse,
            },
            { name: "ephemeral point not on curve", ciphertext: offCurve, error: parse },
        ])("$name", ({ ciphertext, error }) => {
            expect(() => open(priv, ciphertext, TEMPLATE_ID)).toThrow(error);
        });
    });
});
