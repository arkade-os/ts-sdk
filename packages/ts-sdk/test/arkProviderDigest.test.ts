import { describe, it, expect, vi, afterEach } from "vitest";
import { RestArkProvider, DigestMismatchError } from "../src/providers/ark";

const SIGNER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

afterEach(() => vi.unstubAllGlobals());

describe("RestArkProvider server-info digest negotiation", () => {
    it("on DIGEST_MISMATCH: refreshes info, emits onServerInfoChanged, and throws (no silent retry)", async () => {
        const provider = new RestArkProvider("http://ark.test");

        const calls: { url: string; init?: RequestInit }[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: RequestInit) => {
                calls.push({ url, init });
                if (url.includes("/info")) {
                    return { ok: true, json: async () => ({ signerPubkey: SIGNER, digest: "d2" }) };
                }
                // arkd rejects: our cached digest is stale.
                const mismatch = '{"message":"DIGEST_MISMATCH"}';
                return {
                    ok: false,
                    clone: () => ({ text: async () => mismatch }),
                    text: async () => mismatch,
                };
            }),
        );

        // Seed the cached digest so X-Digest is sent on the request below.
        await provider.getInfo();

        const seen: { signerPubkey: string }[] = [];
        provider.onServerInfoChanged((info) => seen.push(info));

        // Mirrors NArk #131: the SDK throws rather than silently retrying a
        // request that was built against the now-stale server config.
        await expect(provider.submitTx("rawtx", [])).rejects.toBeInstanceOf(DigestMismatchError);

        // Detection still fired: info refreshed + emitted exactly once.
        expect(seen).toHaveLength(1);
        expect(seen[0].signerPubkey).toBe(SIGNER);
        // The request was attempted exactly once (no silent retry) and carried X-Digest.
        const submits = calls.filter((c) => c.url.includes("/tx/submit"));
        expect(submits).toHaveLength(1);
        expect((submits[0].init?.headers as Record<string, string>)["X-Digest"]).toBe("d2");
    });

    it("does not emit or retry when a non-digest error comes back", async () => {
        const provider = new RestArkProvider("http://ark.test");
        let submitAttempts = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.includes("/info")) {
                    return { ok: true, json: async () => ({ signerPubkey: SIGNER, digest: "d2" }) };
                }
                submitAttempts++;
                const other = '{"message":"SOMETHING_ELSE"}';
                return {
                    ok: false,
                    clone: () => ({ text: async () => other }),
                    text: async () => other,
                };
            }),
        );
        await provider.getInfo();
        const seen: unknown[] = [];
        provider.onServerInfoChanged((info) => seen.push(info));

        await expect(provider.submitTx("rawtx", [])).rejects.toThrow();
        // No digest mismatch → no refresh, no emit, no retry (single attempt).
        expect(seen).toHaveLength(0);
        expect(submitAttempts).toBe(1);
    });
});
