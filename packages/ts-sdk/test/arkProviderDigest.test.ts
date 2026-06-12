import { describe, it, expect, vi, afterEach } from "vitest";
import { RestArkProvider } from "../src/providers/ark";

const SIGNER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

afterEach(() => vi.unstubAllGlobals());

describe("RestArkProvider server-info digest negotiation", () => {
    it("on DIGEST_MISMATCH: refreshes info, emits onServerInfoChanged, retries with X-Digest", async () => {
        const provider = new RestArkProvider("http://ark.test");

        const calls: { url: string; init?: RequestInit }[] = [];
        let submitAttempts = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: RequestInit) => {
                calls.push({ url, init });
                if (url.includes("/info")) {
                    return { ok: true, json: async () => ({ signerPubkey: SIGNER, digest: "d2" }) };
                }
                // First submit carries a stale digest → arkd rejects; retry is ok.
                submitAttempts++;
                if (submitAttempts === 1) {
                    const mismatch = '{"message":"DIGEST_MISMATCH"}';
                    return {
                        ok: false,
                        clone: () => ({ text: async () => mismatch }),
                        text: async () => mismatch,
                    };
                }
                return {
                    ok: true,
                    json: async () => ({
                        arkTxid: "a1",
                        finalArkTx: "f1",
                        signedCheckpointTxs: [],
                    }),
                };
            }),
        );

        // Seed the cached digest so X-Digest is sent on subsequent requests.
        await provider.getInfo();

        const seen: { signerPubkey: string }[] = [];
        provider.onServerInfoChanged((info) => seen.push(info));

        const result = await provider.submitTx("rawtx", []);

        // The request transparently retried and succeeded.
        expect(result.arkTxid).toBe("a1");
        // The refreshed info was emitted exactly once.
        expect(seen).toHaveLength(1);
        expect(seen[0].signerPubkey).toBe(SIGNER);
        // submit was attempted twice; the retry carried the refreshed X-Digest.
        const submits = calls.filter((c) => c.url.includes("/tx/submit"));
        expect(submits).toHaveLength(2);
        expect((submits[1].init?.headers as Record<string, string>)["X-Digest"]).toBe("d2");
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
