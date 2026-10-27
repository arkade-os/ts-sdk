import { afterEach, describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import {
    attestEnclave,
    checkAttestationPolicy,
    verifyNitroAttestation,
} from "../../src/enclave/attestation";
import { decodeCbor, encodeCbor } from "../../src/enclave/cbor";
import { EnclaveAttestationError, ProviderUnavailableError } from "../../src/providers/errors";
import { concat, makeNitroChain, makeNitroFixture } from "../helpers/nitroFixture";
import { textResponse } from "../helpers/response";

const verify = (doc: Uint8Array, rootDer: Uint8Array) =>
    verifyNitroAttestation(doc, { nowMs: Date.now(), roots: [rootDer] });

describe("verifyNitroAttestation", () => {
    it("verifies the COSE signature and chain and returns the payload", () => {
        const f = makeNitroFixture();
        const doc = verify(f.doc, f.rootDer);
        expect(doc.moduleId).toBe("i-test-enc");
        expect(hex.encode(doc.pcrs.get(0)!)).toBe(f.pcr0);
        expect(doc.nonce).toEqual(f.nonce);
    });

    it("rejects a document whose root isn't trusted", () => {
        const f = makeNitroFixture();
        expect(() => verify(f.doc, makeNitroFixture().rootDer)).toThrow();
    });

    it("rejects a COSE signature by a key other than the leaf's", () => {
        const f = makeNitroFixture({ wrongCoseKey: true });
        expect(() => verify(f.doc, f.rootDer)).toThrow(/COSE signature/);
    });

    it("rejects a tampered payload", () => {
        const f = makeNitroFixture();
        const [protectedHeader, unprotected, payload, signature] = decodeCbor(f.doc) as any[];
        const fields = decodeCbor(payload) as Map<string, unknown>;
        fields.set("nonce", new Uint8Array(20));
        const tampered = encodeCbor([
            protectedHeader,
            unprotected,
            encodeCbor(fields as any),
            signature,
        ]);
        expect(() => verify(tampered, f.rootDer)).toThrow(/COSE signature/);
    });

    it("rejects an algorithm other than ES384", () => {
        const f = makeNitroFixture();
        const [, unprotected, payload, signature] = decodeCbor(f.doc) as any[];
        const es256 = encodeCbor(new Map([[1, -7]]));
        const doc = encodeCbor([es256, unprotected, payload, signature]);
        expect(() => verify(doc, f.rootDer)).toThrow(/ES384/);
    });
});

describe("checkAttestationPolicy", () => {
    const policyFor = (f: ReturnType<typeof makeNitroFixture>, pcr0 = [f.pcr0]) => ({
        nonce: f.nonce,
        pcr0,
    });

    it("returns the response signing key from user_data", () => {
        const f = makeNitroFixture();
        expect(checkAttestationPolicy(verify(f.doc, f.rootDer), policyFor(f))).toEqual(
            f.signingKey,
        );
    });

    it("accepts any listed PCR0 and rejects an unlisted one", () => {
        const f = makeNitroFixture();
        const doc = verify(f.doc, f.rootDer);
        expect(checkAttestationPolicy(doc, policyFor(f, ["00".repeat(48), f.pcr0]))).toEqual(
            f.signingKey,
        );
        expect(() => checkAttestationPolicy(doc, policyFor(f, ["00".repeat(48)]))).toThrow(
            /not an accepted image/,
        );
    });

    it("rejects a nonce other than the one sent", () => {
        const f = makeNitroFixture();
        const doc = verify(f.doc, f.rootDer);
        expect(() =>
            checkAttestationPolicy(doc, { nonce: new Uint8Array(20), pcr0: [f.pcr0] }),
        ).toThrow(/nonce/);
    });

    const enc = new TextEncoder();
    it.each([
        ["the old 68-byte layout", new Uint8Array(68), /79-byte/],
        [
            "wrong prefixes",
            concat(
                enc.encode("sha512:"),
                new Uint8Array(32).fill(1),
                enc.encode("ed25519:"),
                new Uint8Array(32).fill(1),
            ),
            /prefixes/,
        ],
        [
            "an empty TLS key hash",
            concat(
                enc.encode("sha256:"),
                new Uint8Array(32),
                enc.encode("ed25519:"),
                new Uint8Array(32).fill(1),
            ),
            /TLS key hash/,
        ],
        [
            "no signing key yet",
            concat(
                enc.encode("sha256:"),
                new Uint8Array(32).fill(1),
                enc.encode("ed25519:"),
                new Uint8Array(32),
            ),
            /no response signing key/,
        ],
    ])("rejects user_data with %s", (_name, userData, error) => {
        const f = makeNitroFixture({ userData });
        expect(() => checkAttestationPolicy(verify(f.doc, f.rootDer), policyFor(f))).toThrow(error);
    });
});

describe("attestEnclave", () => {
    afterEach(() => vi.unstubAllGlobals());

    // One chain for the file: its root stands in for AWS's through `roots`.
    const chain = makeNitroChain();

    /** Answer the attestation request with a fixture echoing the request's nonce. */
    function stubEnclave(opts: { pcr0?: Uint8Array; wrap?: (doc: string) => string } = {}) {
        const urls: string[] = [];
        let fixture: ReturnType<typeof makeNitroFixture> | undefined;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL) => {
                const url = new URL(String(input));
                urls.push(url.toString());
                fixture = makeNitroFixture({
                    chain,
                    nonce: hex.decode(url.searchParams.get("nonce")!),
                    pcr0: opts.pcr0,
                });
                const doc = base64.encode(fixture.doc);
                return textResponse(opts.wrap ? opts.wrap(doc) : doc);
            }),
        );
        return { urls, fixture: () => fixture! };
    }

    const PCR0 = new Uint8Array(48).fill(0xab);
    const config = { pcr0: [hex.encode(PCR0).toUpperCase()], roots: [chain.rootDer] };

    it("trusts only the AWS Nitro root unless told otherwise", async () => {
        stubEnclave({ pcr0: PCR0 });
        await expect(
            attestEnclave("https://emulator.example", { pcr0: config.pcr0 }),
        ).rejects.toThrow(/trusted root/);
    });

    it("fetches the document with a fresh 40-hex nonce and returns the signing key", async () => {
        const enclave = stubEnclave({ pcr0: PCR0 });
        const key = await attestEnclave("https://emulator.example", config);
        expect(key).toEqual(enclave.fixture().signingKey);
        expect(enclave.urls[0]).toMatch(
            /^https:\/\/emulator\.example\/enclave\/attestation\?nonce=[0-9a-f]{40}$/,
        );
    });

    it("reaches the attestation at the origin root behind a path prefix", async () => {
        const enclave = stubEnclave({ pcr0: PCR0 });
        await attestEnclave("https://gateway.example/emulator", config);
        expect(new URL(enclave.urls[0]).pathname).toBe("/enclave/attestation");
    });

    it("accepts the JSON envelope", async () => {
        stubEnclave({ pcr0: PCR0, wrap: (doc) => JSON.stringify({ document: doc }) });
        await expect(attestEnclave("https://emulator.example", config)).resolves.toBeInstanceOf(
            Uint8Array,
        );
    });

    it("fails closed with EnclaveAttestationError for an unlisted image", async () => {
        stubEnclave({ pcr0: new Uint8Array(48).fill(1) });
        await expect(attestEnclave("https://emulator.example", config)).rejects.toThrow(
            EnclaveAttestationError,
        );
    });

    it("reports 503 (app not started) as retryable, other failures as terminal", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => textResponse("starting", { status: 503 })),
        );
        await expect(attestEnclave("https://emulator.example", config)).rejects.toThrow(
            ProviderUnavailableError,
        );
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => textResponse("nope", { status: 404 })),
        );
        await expect(attestEnclave("https://emulator.example", config)).rejects.toThrow(
            EnclaveAttestationError,
        );
    });

    it("rejects a malformed PCR0 list before any request", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        await expect(attestEnclave("https://emulator.example", { pcr0: [] })).rejects.toThrow(
            /pcr0/,
        );
        await expect(attestEnclave("https://emulator.example", { pcr0: ["abcd"] })).rejects.toThrow(
            /pcr0/,
        );
        // A single string, not a list, from a JS caller.
        await expect(
            attestEnclave("https://emulator.example", { pcr0: "ab".repeat(48) as any }),
        ).rejects.toThrow(/pcr0/);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
