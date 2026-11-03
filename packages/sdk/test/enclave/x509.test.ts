import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";
import { AWS_NITRO_ROOTS } from "../../src/enclave/attestation";
import { parseCertificate, verifyChain } from "../../src/enclave/x509";
import { DAY, makeCert, p384Keys, type CertOptions } from "../helpers/nitroFixture";

describe("AWS Nitro root", () => {
    it("is the certificate AWS documents", () => {
        expect(AWS_NITRO_ROOTS).toHaveLength(1);
        expect(hex.encode(sha256(AWS_NITRO_ROOTS[0]))).toBe(
            "641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b",
        );
        const root = parseCertificate(AWS_NITRO_ROOTS[0]);
        expect(root.ca).toBe(true);
        expect(root.keyCertSign).toBe(true);
        expect(new Date(root.notBefore).toISOString()).toBe("2019-10-28T13:28:05.000Z");
        expect(new Date(root.notAfter).toISOString()).toBe("2049-10-28T14:28:05.000Z");
        expect(new TextDecoder().decode(root.subject)).toContain("aws.nitro-enclaves");
    });
});

/** root → intermediate → leaf, with overrides for the intermediate. */
function chain(intermediate: Partial<CertOptions> = {}) {
    const root = p384Keys();
    const inter = p384Keys();
    const leaf = p384Keys();
    const rootDer = makeCert({
        subject: "root",
        issuer: "root",
        publicKey: root.publicKey,
        issuerKey: root.secretKey,
        ca: true,
    });
    const interDer = makeCert({
        subject: "intermediate",
        issuer: "root",
        publicKey: inter.publicKey,
        issuerKey: root.secretKey,
        ca: true,
        ...intermediate,
    });
    const leafDer = makeCert({
        subject: "leaf",
        issuer: "intermediate",
        publicKey: leaf.publicKey,
        issuerKey: inter.secretKey,
        ca: false,
    });
    return { rootDer, interDer, leafDer, leafKey: leaf.publicKey };
}

describe("verifyChain", () => {
    it("accepts a chain to the trusted root, with or without the root in the bundle", () => {
        const c = chain({ pathLen: 0 });
        const now = Date.now();
        expect(verifyChain(c.leafDer, [c.rootDer, c.interDer], [c.rootDer], now).publicKey).toEqual(
            c.leafKey,
        );
        expect(verifyChain(c.leafDer, [c.interDer], [c.rootDer], now).publicKey).toEqual(c.leafKey);
    });

    it("rejects a chain to another root, even one with the same name", () => {
        const c = chain();
        const impostor = chain().rootDer; // also named "root", different key
        expect(() => verifyChain(c.leafDer, [c.interDer], [impostor], Date.now())).toThrow(
            /invalid certificate signature/,
        );
        const k = p384Keys();
        const unrelated = makeCert({
            subject: "other root",
            issuer: "other root",
            publicKey: k.publicKey,
            issuerKey: k.secretKey,
            ca: true,
        });
        expect(() => verifyChain(c.leafDer, [c.interDer], [unrelated], Date.now())).toThrow(
            /trusted root/,
        );
    });

    it("tries every trusted root with the issuer's name, not just the first", () => {
        const c = chain();
        const sameName = chain().rootDer; // also named "root", different key
        expect(
            verifyChain(c.leafDer, [c.interDer], [sameName, c.rootDer], Date.now()).publicKey,
        ).toEqual(c.leafKey);
    });

    it("checks validity at the given time", () => {
        const c = chain();
        expect(() =>
            verifyChain(c.leafDer, [c.interDer], [c.rootDer], Date.now() + 2 * DAY),
        ).toThrow(/not valid/);
        const expired = chain({ notAfter: Date.now() - 1000 });
        expect(() =>
            verifyChain(expired.leafDer, [expired.interDer], [expired.rootDer], Date.now()),
        ).toThrow(/not valid/);
    });

    it("rejects an issuer that is not a CA", () => {
        const c = chain({ ca: false });
        expect(() => verifyChain(c.leafDer, [c.interDer], [c.rootDer], Date.now())).toThrow(
            /certificate authority/,
        );
    });

    it("enforces path length constraints", () => {
        const root = p384Keys();
        const a = p384Keys();
        const b = p384Keys();
        const leaf = p384Keys();
        const rootDer = makeCert({
            subject: "root",
            issuer: "root",
            publicKey: root.publicKey,
            issuerKey: root.secretKey,
            ca: true,
        });
        const aDer = makeCert({
            subject: "a",
            issuer: "root",
            publicKey: a.publicKey,
            issuerKey: root.secretKey,
            ca: true,
            pathLen: 0, // allows no CA below it, but b follows
        });
        const bDer = makeCert({
            subject: "b",
            issuer: "a",
            publicKey: b.publicKey,
            issuerKey: a.secretKey,
            ca: true,
        });
        const leafDer = makeCert({
            subject: "leaf",
            issuer: "b",
            publicKey: leaf.publicKey,
            issuerKey: b.secretKey,
            ca: false,
        });
        expect(() => verifyChain(leafDer, [aDer, bDer], [rootDer], Date.now())).toThrow(
            /path length/,
        );
    });

    it("rejects an unknown critical extension", () => {
        const c = chain({ unknownCritical: true });
        expect(() => verifyChain(c.leafDer, [c.interDer], [c.rootDer], Date.now())).toThrow(
            /critical extension/,
        );
    });

    it("rejects a tampered certificate", () => {
        const c = chain();
        const tampered = c.leafDer.slice();
        tampered[tampered.length - 1] ^= 1; // last signature byte
        expect(() => verifyChain(tampered, [c.interDer], [c.rootDer], Date.now())).toThrow();
    });
});

describe("parseCertificate", () => {
    // A SEQUENCE whose only child announces a 2-byte length its parent has no room for.
    it("rejects a long-form length cut off by its parent", () => {
        expect(() => parseCertificate(Uint8Array.of(0x30, 0x02, 0x30, 0x82))).toThrow(
            /DER: truncated/,
        );
    });
});
