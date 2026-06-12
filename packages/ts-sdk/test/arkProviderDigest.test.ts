import { describe, it, expect, vi, afterEach } from "vitest";
import { RestArkProvider, DigestMismatchError } from "../src/providers/ark";

const SIGNER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

/** A 200 /v1/info response advertising the given digest. */
function okInfo(digest: string) {
    return { ok: true, json: async () => ({ signerPubkey: SIGNER, digest }) };
}

/** A rejected non-/info response whose body carries the given marker. */
function errBody(marker: string) {
    const body = `{"message":"${marker}"}`;
    return { ok: false, clone: () => ({ text: async () => body }), text: async () => body };
}

/** Read/write the provider's private cached digest without a real round-trip. */
function digestOf(provider: RestArkProvider): string {
    return (provider as unknown as { _digest: string })._digest;
}
function seedDigest(provider: RestArkProvider, digest: string): void {
    (provider as unknown as { _digest: string })._digest = digest;
}

afterEach(() => vi.unstubAllGlobals());

describe("RestArkProvider server-info digest negotiation", () => {
    it("getInfo caches the server digest", async () => {
        const provider = new RestArkProvider("http://ark.test");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => okInfo("dX")),
        );

        await provider.getInfo();

        expect(digestOf(provider)).toBe("dX");
    });

    it("sends X-Digest, and on DIGEST_MISMATCH refreshes + emits + throws (no silent retry)", async () => {
        const provider = new RestArkProvider("http://ark.test");
        // Seed directly so the X-Digest assertion does not depend on a prior
        // getInfo round-trip surviving to the request below.
        seedDigest(provider, "d2");

        const calls: { url: string; init?: RequestInit }[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: RequestInit) => {
                calls.push({ url, init });
                if (url.includes("/info")) return okInfo("d3");
                return errBody("DIGEST_MISMATCH");
            }),
        );

        const seen: { signerPubkey: string }[] = [];
        provider.onServerInfoChanged((info) => seen.push(info));

        // Mirrors NArk #131: the SDK throws rather than silently retrying a
        // request that was built against the now-stale server config.
        await expect(provider.submitTx("rawtx", [])).rejects.toBeInstanceOf(DigestMismatchError);

        // The request carried the cached X-Digest and was attempted exactly once.
        const submits = calls.filter((c) => c.url.includes("/tx/submit"));
        expect(submits).toHaveLength(1);
        expect((submits[0].init?.headers as Record<string, string>)["X-Digest"]).toBe("d2");
        // Detection fired: info refreshed + emitted exactly once.
        expect(seen).toHaveLength(1);
        expect(seen[0].signerPubkey).toBe(SIGNER);
    });

    it("does not emit or retry when a non-digest error comes back", async () => {
        const provider = new RestArkProvider("http://ark.test");
        seedDigest(provider, "d2");

        let submitAttempts = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (url.includes("/info")) return okInfo("d2");
                submitAttempts++;
                return errBody("SOMETHING_ELSE");
            }),
        );

        const seen: unknown[] = [];
        provider.onServerInfoChanged((info) => seen.push(info));

        await expect(provider.submitTx("rawtx", [])).rejects.toThrow();
        // No digest mismatch → no refresh, no emit, no retry (single attempt).
        expect(seen).toHaveLength(0);
        expect(submitAttempts).toBe(1);
    });
});
