import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base64, hex } from "@scure/base";
import { sha256 } from "@scure/btc-signer/utils.js";
import {
    canonicalHeadersHash,
    signedGet,
    signedResponseMessage,
} from "../../src/enclave/signedResponse";
import { EnclaveAttestationError } from "../../src/providers/errors";

const utf8 = (s: string) => new TextEncoder().encode(s);

// Mirrors TestSignedRequestWireFormat in the enclave's Go client, which pins the same contract.
describe("wire format", () => {
    it("matches the Go client's golden message", () => {
        const headersHash = canonicalHeadersHash([
            ["Authorization", " Bearer alice\t"],
            ["Content-Type", "application/json"],
            ["X-Enclave-Sign-Nonce", "n1"],
            ["X-Tenant", "one"], // not covered
            ["X-Tenant", "two"],
        ]);
        const canonical =
            "authorization:QmVhcmVyIGFsaWNl\n" +
            "content-type:YXBwbGljYXRpb24vanNvbg==\n" +
            "x-enclave-sign-nonce:bjE=\n";
        expect(headersHash).toEqual(sha256(utf8(canonical)));

        const message = signedResponseMessage(
            {
                method: "POST",
                target: "/orders?x=1",
                authority: "api.example:443",
                headersHash,
                bodyHash: sha256(utf8("amount=10")),
            },
            201,
            sha256(utf8("echo:amount=10")),
        );
        expect(new TextDecoder().decode(message)).toBe(
            "enclave-signed-response\nPOST /orders?x=1\napi.example:443\n" +
                hex.encode(sha256(utf8(canonical))) +
                "\n" +
                hex.encode(sha256(utf8("amount=10"))) +
                "\n201\n" +
                hex.encode(sha256(utf8("echo:amount=10"))),
        );
    });

    const h = (pairs: [string, string][]) => hex.encode(canonicalHeadersHash(pairs));
    it.each<[string, [string, string][], [string, string][], boolean]>([
        [
            "name case and edge whitespace",
            [["authorization", " \tBearer alice\t "]],
            [["Authorization", "Bearer alice"]],
            true,
        ],
        [
            "internal whitespace matters",
            [["Authorization", "Bearer  alice"]],
            [["Authorization", "Bearer alice"]],
            false,
        ],
        ["empty is not absent", [["Authorization", ""]], [], false],
        [
            "duplicates are not comma folding",
            [
                ["Authorization", "alice"],
                ["Authorization", "bob"],
            ],
            [["Authorization", "alice,bob"]],
            false,
        ],
        [
            "duplicate order matters",
            [
                ["Authorization", "alice"],
                ["Authorization", "bob"],
            ],
            [
                ["Authorization", "bob"],
                ["Authorization", "alice"],
            ],
            false,
        ],
        [
            "uncovered headers are ignored",
            [
                ["Cookie", "session=bob"],
                ["Origin", "https://evil.example"],
                ["X-Forwarded-For", "10.0.0.1"],
            ],
            [],
            true,
        ],
    ])("canonical headers: %s", (_name, a, b, equal) => {
        expect(h(a) === h(b)).toBe(equal);
    });
});

describe("signedGet", () => {
    afterEach(() => vi.unstubAllGlobals());

    const secret = ed25519.utils.randomSecretKey();
    const key = ed25519.getPublicKey(secret);

    /**
     * A runtime stub signing what it received; `sign` lets a test sign something else. Built
     * inline rather than with the module under test.
     */
    function stubRuntime(
        opts: {
            status?: number;
            body?: string;
            signedBody?: string;
            signedPath?: string;
            omitSignature?: boolean;
        } = {},
    ) {
        const seen: { url: string; init?: RequestInit }[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string, init?: RequestInit) => {
                seen.push({ url: input, init });
                const url = new URL(input);
                const nonce = new Headers(init?.headers).get("X-Enclave-Sign-Nonce") ?? "";
                const status = opts.status ?? 200;
                const body = opts.body ?? '{"signerPubkey":"02ab"}';
                const message =
                    `enclave-signed-response\nGET ${opts.signedPath ?? url.pathname + url.search}\n` +
                    `${url.host}\n` +
                    `${hex.encode(sha256(utf8(`x-enclave-sign-nonce:${btoa(nonce)}\n`)))}\n` +
                    `${hex.encode(sha256(new Uint8Array(0)))}\n${status}\n` +
                    hex.encode(sha256(utf8(opts.signedBody ?? body)));
                const headers: Record<string, string> = opts.omitSignature
                    ? {}
                    : {
                          "X-Enclave-Signature": base64.encode(ed25519.sign(utf8(message), secret)),
                      };
                return new Response(body, { status, headers });
            }),
        );
        return seen;
    }

    it("returns the body of a response signed for this request", async () => {
        stubRuntime();
        const { response, body } = await signedGet(
            "https://emulator.example:8443/v1/info?x=1",
            key,
        );
        expect(response.status).toBe(200);
        expect(new TextDecoder().decode(body)).toBe('{"signerPubkey":"02ab"}');
    });

    it("sends only a fresh nonce header and refuses redirects", async () => {
        const seen = stubRuntime();
        await signedGet("https://emulator.example/v1/info", key);
        await signedGet("https://emulator.example/v1/info", key);
        const [first, second] = seen.map((s) => new Headers(s.init?.headers));
        expect([...first.keys()]).toEqual(["x-enclave-sign-nonce"]);
        expect(first.get("x-enclave-sign-nonce")).toMatch(/^[0-9a-f]{32}$/);
        expect(first.get("x-enclave-sign-nonce")).not.toBe(second.get("x-enclave-sign-nonce"));
        expect(seen[0].init?.redirect).toBe("error");
        expect(seen[0].init?.cache).toBeUndefined();
    });

    it.each([
        ["a missing signature", { omitSignature: true }],
        ["a signature over another body", { signedBody: '{"signerPubkey":"03ff"}' }],
        ["a signature over another path", { signedPath: "/v1/other" }],
    ])("rejects %s", async (_name, opts) => {
        stubRuntime(opts);
        await expect(signedGet("https://emulator.example/v1/info", key)).rejects.toThrow(
            EnclaveAttestationError,
        );
    });

    // A browser hides a cross-origin response header the server doesn't expose.
    it("points at CORS when the signature header is missing", async () => {
        stubRuntime({ omitSignature: true });
        await expect(signedGet("https://emulator.example/v1/info", key)).rejects.toThrow(
            /no X-Enclave-Signature.*Access-Control-Expose-Headers/,
        );
    });

    it("rejects a signature by another key", async () => {
        stubRuntime();
        const other = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
        await expect(signedGet("https://emulator.example/v1/info", other)).rejects.toThrow(
            EnclaveAttestationError,
        );
    });

    it("hands non-2xx responses back unverified", async () => {
        stubRuntime({ status: 503, body: "starting", omitSignature: true });
        const { response, body } = await signedGet("https://emulator.example/v1/info", key);
        expect(response.status).toBe(503);
        expect(new TextDecoder().decode(body)).toBe("starting");
    });
});
